import { WasmBridge } from '@/upstream/core';
import type { DocumentInfo } from '@/upstream/core';
import { showHwpPasswordDialog, showHwpSavePasswordDialog } from '@/upstream/ui';
import { remove, stat } from '@tauri-apps/plugin-fs';
import { finiteFileSize, readFileInChunks, writeFileInChunks } from './chunked-fs';
import { shouldEncryptNewSaves } from './save-password-preference';

type DocumentFormat = 'hwp' | 'hwpx';

// rhwp가 던지는 오류 메시지의 부분 문자열이다. upstream rhwp-studio의 main.ts가 같은 문자열로
// 암호 필요/오답을 판별하므로 그 정책을 그대로 따른다 (golbin/hop#98).
const PASSWORD_REQUIRED_MESSAGE = '비밀번호가 필요한 암호 문서';
const PASSWORD_REJECTED_MESSAGE = '비밀번호가 일치하지 않거나 암호화 데이터가 손상되었습니다';

function isPasswordRequiredError(error: unknown): boolean {
  return String(error).includes(PASSWORD_REQUIRED_MESSAGE);
}

function isPasswordRejectedError(error: unknown): boolean {
  return String(error).includes(PASSWORD_REJECTED_MESSAGE);
}

/**
 * 오입력과 암호문 손상은 암호학적으로 구분할 수 없고, 원본 오류에는 사용자가 입력한 내용이 섞여
 * 들어올 수 있다. 그래서 화면에는 안전한 일반 안내만 노출한다 (upstream main.ts와 동일 정책).
 */
function passwordOpenFailure(error: unknown): Error {
  const message = String(error);
  if (message.includes('지원하지 않는 암호화 방식')) {
    return new Error('지원하지 않는 암호화 방식의 문서입니다. 지원되는 HWP3/HWP5 암호 문서만 열 수 있습니다.');
  }
  if (message.includes('DRM')) {
    return new Error('DRM으로 보호된 문서는 지원하지 않습니다.');
  }
  // 화면에는 안전한 일반 안내만 보여주지만, 진단을 위해 원본 오류는 devtools 콘솔에 남긴다.
  console.warn('[tauri-bridge] 암호 문서 열기 실패 원인:', message);
  return new Error('암호화된 문서를 열 수 없습니다. 문서가 손상되었는지 확인하세요.');
}

interface NativeOpenResult {
  docId: string;
  fileName: string;
  sourcePath?: string | null;
  format: DocumentFormat;
  pageCount: number;
  revision: number;
  dirty: boolean;
  warnings: unknown[];
}

interface SourceFingerprint {
  len: number;
  modifiedMillis: number;
  contentHash: number;
}

interface ExternalModificationStatus {
  changed: boolean;
  sourcePath?: string | null;
  reason?: string | null;
}

export type DesktopUpdateState =
  | { status: 'idle' }
  | {
      status: 'available';
      version: string;
    }
  | {
      status: 'downloading';
      version: string;
      downloadedBytes: number;
      totalBytes?: number | null;
    }
  | {
      status: 'ready';
      version: string;
    }
  | {
      status: 'error';
      version: string;
      message: string;
    };

export interface DesktopSaveResult {
  docId: string;
  sourcePath?: string | null;
  format: DocumentFormat;
  revision: number;
  dirty: boolean;
  warnings: unknown[];
}

export interface RecentDocument {
  path: string;
  fileName: string;
}

export interface DesktopLoadPayload {
  docInfo: DocumentInfo;
  message: string;
}

export interface DesktopBridgeApi {
  openDocumentFromDialog(): Promise<DesktopLoadPayload | null>;
  openDocumentByPath(path: string): Promise<DesktopLoadPayload | null>;
  takePendingOpenPaths(): Promise<string[]>;
  createNewDocumentAsync(): Promise<DesktopLoadPayload | null>;
  createNewWindow(): Promise<string>;
  saveDocumentFromCommand(): Promise<DesktopSaveResult | null>;
  saveDocumentAsFromCommand(): Promise<DesktopSaveResult | null>;
  exportPdfFromCommand(): Promise<string | null>;
  printCurrentWebview(): Promise<void>;
  destroyCurrentWindow(): Promise<void>;
  cancelAppQuit(): Promise<void>;
  revealInFolder(): Promise<void>;
  listRecentDocuments(): Promise<RecentDocument[]>;
  clearRecentDocuments(): Promise<void>;
  renderDocumentPreview(path: string): Promise<string>;
  getUpdateState(): Promise<DesktopUpdateState>;
  startUpdateInstall(): Promise<void>;
  restartToApplyUpdate(): Promise<void>;
  hasUnsavedChanges(): boolean;
  markDocumentDirty(): void;
  confirmWindowClose(): Promise<boolean>;
}

export class TauriBridge extends WasmBridge implements DesktopBridgeApi {
  private docId: string | null = null;
  private sourcePath: string | null = null;
  private sourceFormat: DocumentFormat = 'hwp';
  private revision = 0;
  private dirty = false;

  async openDocumentFromDialog(): Promise<DesktopLoadPayload | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      multiple: false,
      filters: [{ name: 'HWP/HWPX 문서', extensions: ['hwp', 'hwpx'] }],
    });
    if (!selected || Array.isArray(selected)) return null;
    return this.openDocumentByPath(selected);
  }

  async openDocumentByPath(path: string): Promise<DesktopLoadPayload | null> {
    if (!(await this.confirmReadyForDocumentReplacement())) return null;

    await this.invoke<void>('prepare_document_open', { path });
    const { bytes, sourceFingerprint } = await this.readFileForOpen(path);
    const result = await this.invoke<NativeOpenResult>('open_document_tracking', {
      path,
      sourceFingerprint,
    });
    const previousDocId = this.docId;
    try {
      const info = await this.loadDocumentForOpen(bytes, result.fileName);
      if (!info) {
        // 사용자가 암호 입력 대화상자를 취소했다. 새로 등록된 네이티브 문서만 정리한다.
        await this.closeNativeDocument(result.docId);
        return null;
      }
      this.applyNativeOpenResult(result, this.normalizedSourceFormat(super.getSourceFormat()));
      await this.noteFinderRecentDocument(path);
      await this.recordRecentDocument(path);
      await this.closeReplacedDocument(previousDocId, result.docId);
      return {
        docInfo: info,
        message: `${result.fileName} — ${info.pageCount}페이지`,
      };
    } catch (error) {
      await this.closeNativeDocument(result.docId);
      throw error;
    }
  }

  /**
   * 일반 열기를 먼저 시도하고, 비밀번호가 필요한 문서로 판별된 경우에만 암호 입력 UI로
   * 전환한다 (golbin/hop#98). rhwp-studio 자체(config/rhwp-studio-overrides.json에 없는
   * main.ts)에는 이미 이 흐름이 구현돼 있지만, HOP은 저수준 loadDocument()를 직접 호출하는
   * 이 파일에서 그 흐름을 거치지 않아 암호 문서를 열 수 없었다.
   */
  private async loadDocumentForOpen(bytes: Uint8Array, fileName: string): Promise<DocumentInfo | null> {
    try {
      const info = super.loadDocument(bytes, fileName);
      // 환경설정 > 파일 탭의 "새 문서도 저장할 때 암호 적용"이 켜져 있으면, 원래 암호가
      // 없던 문서도 이후 저장부터 암호를 묻는다 (golbin/hop#98 후속 요청).
      if (shouldEncryptNewSaves()) this.requiresPasswordForSave = true;
      return info;
    } catch (error) {
      if (!isPasswordRequiredError(error)) throw error;
      return this.loadPasswordProtectedDocument(bytes, fileName);
    }
  }

  private async loadPasswordProtectedDocument(bytes: Uint8Array, fileName: string): Promise<DocumentInfo | null> {
    let retryMessage: string | undefined;

    while (true) {
      const password = await showHwpPasswordDialog(fileName, retryMessage);
      if (password === null) return null;

      try {
        const info = super.loadDocumentWithPassword(bytes, password, fileName);
        // 암호로 연 문서는 재저장할 때도 같은 보호가 유지돼야 한다 (golbin/hop#98 후속 요청).
        this.requiresPasswordForSave = true;
        return info;
      } catch (error) {
        if (isPasswordRejectedError(error)) {
          retryMessage = '암호가 일치하지 않거나 문서가 손상되었습니다. 다시 입력하세요.';
          continue;
        }
        throw passwordOpenFailure(error);
      }
    }
  }

  async takePendingOpenPaths(): Promise<string[]> {
    return this.invoke<string[]>('take_pending_open_paths');
  }

  async createNewDocumentAsync(): Promise<DesktopLoadPayload | null> {
    if (!(await this.confirmReadyForDocumentReplacement())) return null;

    const result = await this.invoke<NativeOpenResult>('create_document');
    const previousDocId = this.docId;
    try {
      const info = super.createNewDocument();
      if (shouldEncryptNewSaves()) this.requiresPasswordForSave = true;
      this.applyNativeOpenResult(result);
      await this.closeReplacedDocument(previousDocId, result.docId);
      return {
        docInfo: info,
        message: `새 문서.hwp — ${info.pageCount}페이지`,
      };
    } catch (error) {
      await this.closeNativeDocument(result.docId);
      throw error;
    }
  }

  async createNewWindow(): Promise<string> {
    return this.invoke<string>('create_editor_window');
  }

  getSourceFormat(): string {
    return this.sourceFormat;
  }

  async saveDocumentFromCommand(): Promise<DesktopSaveResult | null> {
    const docId = this.ensureDocumentLoaded();
    if (!this.sourcePath) {
      return this.saveDocumentAsFromCommand();
    }
    if (this.sourceFormat === 'hwpx') {
      throw new Error('HWPX 원본 저장은 아직 안전하게 지원하지 않습니다. 다른 이름으로 저장에서 HWP 파일로 저장하세요.');
    }
    return this.saveHwpThroughStaging(docId, null);
  }

  async saveDocumentAsFromCommand(): Promise<DesktopSaveResult | null> {
    const docId = this.ensureDocumentLoaded();
    const targetPath = await this.selectSavePath(this.suggestedHwpName(), 'HWP 문서', ['hwp']);
    if (!targetPath) return null;
    return this.saveHwpThroughStaging(docId, this.withExtension(targetPath, 'hwp'));
  }

  async exportPdfFromCommand(): Promise<string | null> {
    this.ensureDocumentLoaded();
    const targetPath = await this.selectSavePath(this.suggestedPdfName(), 'PDF 문서', ['pdf']);
    if (!targetPath) return null;
    const finalPath = this.withExtension(targetPath, 'pdf');
    const stagedPath = await this.invoke<string>('prepare_staged_hwp_pdf_export', {
      targetPath: finalPath,
    });
    try {
      await this.writeCurrentHwpToPath(stagedPath);
      return await this.invoke<string>('export_pdf_from_hwp_path', {
        stagedPath,
        targetPath: finalPath,
        pageRange: null,
        openAfter: true,
      });
    } finally {
      await remove(stagedPath).catch(() => undefined);
    }
  }

  async printCurrentWebview(): Promise<void> {
    await this.invoke<void>('print_webview');
  }

  async destroyCurrentWindow(): Promise<void> {
    await this.invoke<void>('destroy_current_window');
  }

  async cancelAppQuit(): Promise<void> {
    await this.invoke<void>('cancel_app_quit');
  }

  async revealInFolder(): Promise<void> {
    if (!this.sourcePath) return;
    await this.invoke<void>('reveal_in_folder', { path: this.sourcePath });
  }

  async listRecentDocuments(): Promise<RecentDocument[]> {
    return this.invoke<RecentDocument[]>('list_recent_documents');
  }

  async clearRecentDocuments(): Promise<void> {
    await this.invoke<void>('clear_recent_documents');
  }

  async renderDocumentPreview(path: string): Promise<string> {
    return this.invoke<string>('render_document_preview', { path });
  }

  async getUpdateState(): Promise<DesktopUpdateState> {
    return this.invoke<DesktopUpdateState>('get_update_state');
  }

  async startUpdateInstall(): Promise<void> {
    await this.invoke<void>('start_update_install');
  }

  async restartToApplyUpdate(): Promise<void> {
    await this.invoke<void>('restart_to_apply_update');
  }

  hasUnsavedChanges(): boolean {
    return Boolean(this.docId && this.dirty);
  }

  markDocumentDirty(): void {
    if (!this.docId || this.dirty) return;
    this.dirty = true;
    void this.invoke<void>('mark_document_dirty', { docId: this.docId }).catch((error: unknown) => {
      console.warn('[TauriBridge] native dirty state update failed:', error);
    });
    this.updateDocumentTitle();
  }

  async confirmWindowClose(): Promise<boolean> {
    const canClose = await this.confirmReadyForDocumentReplacement();
    if (canClose) await this.releaseCurrentNativeDocument();
    return canClose;
  }

  private async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
  }

  private async closeNativeDocument(docId: string): Promise<void> {
    try {
      await this.invoke<void>('close_document', { docId });
    } catch (error) {
      console.warn('[TauriBridge] native document cleanup failed:', error);
    }
  }

  private async recordRecentDocument(path: string): Promise<void> {
    await this.invoke<void>('record_recent_document', { path }).catch((error: unknown) => {
      console.warn('[TauriBridge] recent document update failed:', error);
    });
  }

  private async noteFinderRecentDocument(path: string): Promise<void> {
    await this.invoke<void>('note_finder_recent_document', { path }).catch((error: unknown) => {
      console.warn('[TauriBridge] Finder recent document update failed:', error);
    });
  }

  private async closeReplacedDocument(previousDocId: string | null, nextDocId: string): Promise<void> {
    if (previousDocId && previousDocId !== nextDocId) {
      await this.closeNativeDocument(previousDocId);
    }
  }

  private async releaseCurrentNativeDocument(): Promise<void> {
    if (this.docId) {
      await this.closeNativeDocument(this.docId);
    }
    this.docId = null;
    this.sourcePath = null;
    this.dirty = false;
    this.updateDocumentTitle();
  }

  private ensureDocumentLoaded(): string {
    if (!this.docId) throw new Error('문서가 로드되지 않았습니다');
    return this.docId;
  }

  private async selectSavePath(
    defaultPath: string,
    filterName: string,
    extensions: string[],
  ): Promise<string | null> {
    const { save } = await import('@tauri-apps/plugin-dialog');
    return save({
      defaultPath,
      filters: [{ name: filterName, extensions }],
    });
  }

  private async saveHwpThroughStaging(
    docId: string,
    targetPath: string | null,
  ): Promise<DesktopSaveResult | null> {
    const finalPath = targetPath ?? this.sourcePath;
    if (!finalPath) throw new Error('새 문서는 저장 경로가 필요합니다');

    const allowExternalOverwrite = await this.confirmExternalOverwriteIfNeeded(docId, finalPath);
    if (allowExternalOverwrite === null) return null;

    const stagedPath = await this.invoke<string>('prepare_staged_hwp_save', { targetPath: finalPath });
    let password: string | null = null;
    try {
      const written = await this.writeCurrentHwpToPathForSave(stagedPath);
      if (written === 'cancelled') return null;
      password = written.password;
      const result = await this.invoke<DesktopSaveResult>('commit_staged_hwp_save', {
        docId,
        stagedPath,
        targetPath: finalPath,
        expectedRevision: this.revision,
        allowExternalOverwrite,
        password,
      });
      this.applyNativeSaveResult(result);
      await this.noteFinderRecentDocument(finalPath);
      return result;
    } finally {
      password = null;
      await remove(stagedPath).catch(() => undefined);
    }
  }

  private async confirmExternalOverwriteIfNeeded(
    docId: string,
    targetPath: string | null,
  ): Promise<boolean | null> {
    const effectivePath = targetPath ?? this.sourcePath;
    const status = await this.invoke<ExternalModificationStatus>('check_external_modification', {
      docId,
      targetPath: effectivePath,
    });
    if (!status.changed) return false;

    const { message } = await import('@tauri-apps/plugin-dialog');
    const overwriteLabel = '덮어쓰기';
    const cancelLabel = '저장 취소';
    const result = await message(
      [
        '원본 파일이 HOP 밖에서 변경되었습니다.',
        status.sourcePath ? `파일: ${status.sourcePath}` : '',
        status.reason ?? '',
        '',
        '그대로 저장하면 외부에서 변경된 내용이 사라질 수 있습니다.',
      ].filter(Boolean).join('\n'),
      {
        title: '외부 변경 감지',
        kind: 'warning',
        buttons: {
          yes: overwriteLabel,
          no: cancelLabel,
          cancel: '취소',
        },
      },
    );

    return result === overwriteLabel || result === 'Yes' ? true : null;
  }

  private async confirmReadyForDocumentReplacement(): Promise<boolean> {
    if (!this.hasUnsavedChanges()) return true;

    const decision = await this.promptUnsavedChanges();
    if (decision === 'cancel') return false;
    if (decision === 'discard') return true;

    try {
      const result = await this.saveCurrentDocumentForSafety();
      return result !== null;
    } catch (error) {
      await this.showError('저장 실패', `문서를 저장하지 못했습니다.\n${error}`);
      return false;
    }
  }

  private async saveCurrentDocumentForSafety(): Promise<DesktopSaveResult | null> {
    if (this.sourceFormat === 'hwpx') {
      return this.saveDocumentAsFromCommand();
    }
    return this.saveDocumentFromCommand();
  }

  private async promptUnsavedChanges(): Promise<'save' | 'discard' | 'cancel'> {
    const { message } = await import('@tauri-apps/plugin-dialog');
    const saveLabel = '저장';
    const discardLabel = '저장 안 함';
    const result = await message(
      `${this.fileName || '현재 문서'}의 변경 내용을 저장할까요?`,
      {
        title: '저장 확인',
        kind: 'warning',
        buttons: {
          yes: saveLabel,
          no: discardLabel,
          cancel: '취소',
        },
      },
    );

    if (result === saveLabel || result === 'Yes') return 'save';
    if (result === discardLabel || result === 'No') return 'discard';
    return 'cancel';
  }

  private async showError(title: string, text: string): Promise<void> {
    const { message } = await import('@tauri-apps/plugin-dialog');
    await message(text, {
      title,
      kind: 'error',
      buttons: { ok: '확인' },
    });
  }

  private async writeCurrentHwpToPath(path: string): Promise<void> {
    await writeFileInChunks(path, super.exportHwp());
  }

  /**
   * 저장 전용 export다. 암호로 열었던 문서는 저장할 때도 암호를 다시 걸어야 한다
   * (golbin/hop#98 후속 요청). PDF 내보내기 등 다른 staging 경로는 암호 없는
   * writeCurrentHwpToPath()를 그대로 쓴다 — 변환 파이프라인이 암호 문서를 못 읽는다.
   * 저장마다 암호를 다시 입력받는다(메모리에 보관하지 않음, upstream main.ts와 동일 정책).
   * 반환한 password는 commit_staged_hwp_save가 staging 바이트를 같은 암호로 재검증하는 데
   * 쓰인다 — 그러지 않으면 방금 암호화한 파일을 암호 없이 재파싱하려다 저장이 실패한다.
   * 호출자가 사용을 마치는 즉시 폐기해야 한다. 사용자가 암호 입력을 취소하면
   * 'cancelled'를 반환해 저장 자체를 취소한다.
   */
  private async writeCurrentHwpToPathForSave(path: string): Promise<{ password: string | null } | 'cancelled'> {
    if (!this.requiresPasswordForSave) {
      await this.writeCurrentHwpToPath(path);
      return { password: null };
    }

    const password = await showHwpSavePasswordDialog(this.fileName);
    if (password === null) return 'cancelled';

    await writeFileInChunks(path, super.exportHwpWithPassword(password));
    return { password };
  }

  private withExtension(path: string, extension: string): string {
    const escaped = extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\.${escaped}$`, 'i').test(path) ? path : `${path}.${extension}`;
  }

  private async readFileForOpen(path: string): Promise<{
    bytes: Uint8Array;
    sourceFingerprint?: SourceFingerprint;
  }> {
    const before = await stat(path);
    const { bytes, contentHash } = await readFileInChunks(path, finiteFileSize(before.size));
    const after = await stat(path);
    const beforeFingerprint = this.statFingerprint(before);
    const afterFingerprint = this.statFingerprint(after);
    if (
      beforeFingerprint &&
      afterFingerprint &&
      (beforeFingerprint.len !== afterFingerprint.len ||
        beforeFingerprint.modifiedMillis !== afterFingerprint.modifiedMillis)
    ) {
      throw new Error('파일을 읽는 중 변경되었습니다. 다시 시도하세요.');
    }
    return {
      bytes,
      sourceFingerprint: afterFingerprint
        ? {
            ...afterFingerprint,
            contentHash,
          }
        : undefined,
    };
  }

  private statFingerprint(
    info: Partial<{
      size: number;
      mtime: Date | null;
    }>,
  ): Pick<SourceFingerprint, 'len' | 'modifiedMillis'> | undefined {
    const size = finiteFileSize(info.size);
    const modifiedMillis = info.mtime instanceof Date ? info.mtime.getTime() : undefined;
    if (size === undefined || modifiedMillis === undefined || !Number.isFinite(modifiedMillis)) {
      return undefined;
    }
    return { len: size, modifiedMillis };
  }

  private normalizedSourceFormat(value: string): DocumentFormat {
    return value === 'hwpx' ? 'hwpx' : 'hwp';
  }

  private applyNativeOpenResult(result: NativeOpenResult, sourceFormat = result.format): void {
    this.docId = result.docId;
    this.sourcePath = result.sourcePath ?? null;
    this.sourceFormat = sourceFormat;
    this.revision = result.revision;
    this.dirty = result.dirty;
    this.fileName = result.fileName;
    this.updateDocumentTitle();
  }

  private applyNativeSaveResult(result: DesktopSaveResult): void {
    this.docId = result.docId;
    this.sourcePath = result.sourcePath ?? null;
    this.sourceFormat = result.format;
    this.revision = result.revision;
    this.dirty = result.dirty;
    if (this.sourcePath) {
      this.fileName = this.sourcePath.split(/[\\/]/).pop() || this.fileName;
    }
    this.updateDocumentTitle();
  }

  private suggestedHwpName(): string {
    const name = this.fileName.replace(/\.(hwp|hwpx)$/i, '') || 'document';
    return `${name}.hwp`;
  }

  private suggestedPdfName(): string {
    const name = this.fileName.replace(/\.(hwp|hwpx)$/i, '') || 'document';
    return `${name}.pdf`;
  }

  private updateDocumentTitle(): void {
    const name = this.docId ? this.fileName || '문서' : 'HOP';
    document.title = `${this.dirty ? '• ' : ''}${name} - HOP`;
  }
}
