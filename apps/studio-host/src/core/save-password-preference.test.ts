import { beforeEach, describe, expect, it } from 'vitest';
import { setEncryptNewSaves, shouldEncryptNewSaves } from './save-password-preference';

function installFakeLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe('save-password-preference', () => {
  beforeEach(() => {
    installFakeLocalStorage();
  });

  it('defaults to false when nothing is stored', () => {
    expect(shouldEncryptNewSaves()).toBe(false);
  });

  it('persists true across reads', () => {
    setEncryptNewSaves(true);
    expect(shouldEncryptNewSaves()).toBe(true);
    expect(localStorage.getItem('hop-encrypt-new-saves')).toBe('true');
  });

  it('persists false after being turned back off', () => {
    setEncryptNewSaves(true);
    setEncryptNewSaves(false);
    expect(shouldEncryptNewSaves()).toBe(false);
  });

  it('treats a corrupted stored value as false', () => {
    localStorage.setItem('hop-encrypt-new-saves', 'not-a-boolean');
    expect(shouldEncryptNewSaves()).toBe(false);
  });

  it('does not throw when localStorage access fails', () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    } as unknown as Storage;

    expect(() => setEncryptNewSaves(true)).not.toThrow();
    expect(shouldEncryptNewSaves()).toBe(false);
  });
});
