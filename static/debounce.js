export const debounce = (fn, wait = 450) => {
  let timer = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const debounced = (...args) => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  debounced.cancel = cancel;
  return debounced;
};
