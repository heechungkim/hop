/**
 * 현재 문서의 암호 보호를 해제하기 전, 기존 암호를 알고 있는지 확인하는 대화상자다
 * (golbin/hop#98 후속 요청). upstream의 HwpPasswordDialog와 모양은 같지만, 그건
 * "문서를 열기 위한" 문구가 고정돼 있어 재사용할 수 없어서(파일이 private) HOP 전용으로
 * 새로 만들었다. upstream 카운터파트가 없는 순수 HOP 파일이다.
 */
import { ModalDialog } from './dialog';

class ConfirmPasswordDialog extends ModalDialog {
  private input!: HTMLInputElement;
  private resolve!: (value: string | null) => void;
  private inputEnterHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor(private readonly fileName: string, private readonly errorMessage?: string) {
    super('암호 해제', 420);
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.style.cssText = 'padding:16px 20px;line-height:1.6;';

    const message = document.createElement('p');
    message.textContent = `"${this.fileName || '현재 문서'}"의 암호 보호를 해제하려면 현재 암호를 입력하세요.`;
    body.appendChild(message);

    const label = document.createElement('label');
    label.htmlFor = 'confirm-password-input';
    label.textContent = '현재 암호';
    body.appendChild(label);

    this.input = document.createElement('input');
    this.input.id = 'confirm-password-input';
    this.input.type = 'password';
    this.input.autocomplete = 'off';
    this.input.setAttribute('aria-describedby', 'confirm-password-help');
    this.input.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:6px;height:28px;';
    body.appendChild(this.input);

    const help = document.createElement('p');
    help.id = 'confirm-password-help';
    help.textContent = '암호가 확인되면 다음 저장부터 암호 없이 저장됩니다.';
    body.appendChild(help);

    if (this.errorMessage) {
      const error = document.createElement('p');
      error.id = 'confirm-password-error';
      error.setAttribute('role', 'alert');
      error.textContent = this.errorMessage;
      body.appendChild(error);
      this.input.setAttribute('aria-describedby', 'confirm-password-help confirm-password-error');
    }
    return body;
  }

  protected onConfirm(): void {
    this.resolve(this.input.value);
  }

  override hide(): void {
    if (this.inputEnterHandler) {
      document.removeEventListener('keydown', this.inputEnterHandler, true);
      this.inputEnterHandler = null;
    }
    if (this.input) this.input.value = '';
    this.resolve(null);
    super.hide();
  }

  showAsync(): Promise<string | null> {
    return new Promise((resolve) => {
      let resolved = false;
      this.resolve = (value) => {
        if (!resolved) {
          resolved = true;
          resolve(value);
        }
      };
      super.show();
      this.dialog.setAttribute('role', 'dialog');
      this.dialog.setAttribute('aria-modal', 'true');
      this.dialog.setAttribute('aria-label', '암호 해제 확인');
      this.inputEnterHandler = (event) => {
        if (event.target === this.input && event.key === 'Enter') {
          event.preventDefault();
          this.onConfirm();
          this.hide();
        }
      };
      document.addEventListener('keydown', this.inputEnterHandler, true);
      requestAnimationFrame(() => this.input.focus());
    });
  }
}

/** 현재 문서 암호를 확인받는다. 취소하면 null을 반환한다. */
export function showConfirmPasswordDialog(fileName: string, errorMessage?: string): Promise<string | null> {
  return new ConfirmPasswordDialog(fileName, errorMessage).showAsync();
}
