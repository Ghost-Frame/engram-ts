// Brain idle state -- shared between server timer and route handlers
let lastQueryTime = Date.now();

export function touchQueryTime(): void {
  lastQueryTime = Date.now();
}

export function getLastQueryTime(): number {
  return lastQueryTime;
}
