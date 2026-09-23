/**
 * 새 문서(암호 없이 열었거나 새로 만든 문서)를 저장할 때도 암호를 걸지 여부를 기억하는
 * HOP 전용 설정이다. rhwp-studio 자체의 `한글`과 달리 별도 "보안" 메뉴가 없어서, 도구 >
 * 환경설정 > 파일 탭의 체크박스 하나로 대신한다 (golbin/hop#98 후속 요청).
 *
 * upstream의 core/user-settings.ts(AppSettings 블롭)를 그대로 두고 별도 키로 저장한다 —
 * 이 설정은 upstream에는 없는 HOP 전용 개념이라, upstream 설정 스키마를 포크해서까지
 * 합칠 필요가 없다.
 */
const STORAGE_KEY = 'hop-encrypt-new-saves';

export function shouldEncryptNewSaves(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setEncryptNewSaves(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // localStorage 접근 불가(프라이빗 모드 등) 시 조용히 무시 — 기본값(false)으로 동작한다.
  }
}
