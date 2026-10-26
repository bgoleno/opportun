import { uuidv7 } from 'uuidv7';

/** New entity id: a lowercase, time-ordered UUIDv7 string. */
export function newId(): string {
  return uuidv7();
}
