import { toolCommands as upstreamToolCommands } from '@/upstream/commands';
import type { CommandDef } from '@/upstream/commands';
import { OptionsDialog, type DocumentPasswordSecurity } from '@/ui/options-dialog';
import { replaceUpstreamCommands } from '../replace-upstream-commands';

/**
 * upstream의 tool:options는 상대 경로(`../../ui/options-dialog`)로 OptionsDialog를 직접
 * import하기 때문에, HOP이 `ui/options-dialog`를 포크해도 그 alias를 타지 않는다. 이 커맨드만
 * `@/ui/options-dialog`(HOP 포크)로 다시 연결한다 (golbin/hop#98 후속 요청).
 */
function documentPasswordSecurity(wasm: unknown): DocumentPasswordSecurity | null {
  if (!wasm || typeof wasm !== 'object') return null;
  const candidate = wasm as Partial<DocumentPasswordSecurity>;
  return typeof candidate.fileName === 'string'
    && typeof candidate.isCurrentDocumentPasswordProtected === 'function'
    && typeof candidate.enableCurrentDocumentPasswordProtection === 'function'
    && typeof candidate.disableCurrentDocumentPasswordProtection === 'function'
    ? candidate as DocumentPasswordSecurity
    : null;
}

const toolOptions: CommandDef = {
  id: 'tool:options',
  label: '환경 설정',
  execute(services) {
    const security = services.getContext().hasDocument ? documentPasswordSecurity(services.wasm) : null;
    const dlg = new OptionsDialog(security, services.eventBus);
    dlg.show();
  },
};

export const toolCommands: CommandDef[] = replaceUpstreamCommands(upstreamToolCommands, [toolOptions]);
