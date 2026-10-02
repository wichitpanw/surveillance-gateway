/**
 * Imperative app dialogs (confirm / prompt) — styled like ConfirmationDialog.
 * Use instead of window.confirm / window.prompt.
 */
const listeners = new Set();

function emit(payload) {
  listeners.forEach((fn) => fn(payload));
}

export function subscribeAppDialog(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * @returns {Promise<boolean>}
 */
export function appConfirm({
  title = 'ยืนยัน',
  description = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'destructive',
} = {}) {
  return new Promise((resolve) => {
    emit({
      type: 'confirm',
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      description,
      confirmText,
      cancelText,
      variant,
      resolve,
    });
  });
}

/**
 * @returns {Promise<string|null>} null if cancelled
 */
export function appPrompt({
  title = 'Input',
  description = '',
  defaultValue = '',
  placeholder = '',
  confirmText = 'OK',
  cancelText = 'Cancel',
} = {}) {
  return new Promise((resolve) => {
    emit({
      type: 'prompt',
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      description,
      defaultValue,
      placeholder,
      confirmText,
      cancelText,
      resolve,
    });
  });
}
