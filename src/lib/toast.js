const listeners = new Set();

export function toast({ title, description, variant = 'default' }) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    description,
    variant,
  };
  listeners.forEach((fn) => fn(item));
  return item.id;
}

export function subscribeToasts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
