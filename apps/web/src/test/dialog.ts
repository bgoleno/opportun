// What a browser does to a native <dialog>, which jsdom does not: it has no Escape handling, so a
// test that presses Escape there passes whatever the dialog does (issue 898). These fire the events
// a browser fires, and close the element where it would.
import { fireEvent } from '@testing-library/react';

/** The browser closes the dialog by itself: no say for the page, only a `close` event after. */
export function browserCloses(dialog: HTMLElement): void {
  dialog.removeAttribute('open');
  fireEvent(dialog, new Event('close'));
}

/**
 * Escape on a modal dialog: a `cancel` the page may refuse, and a native close if it does not.
 * Returns whether it was refused.
 */
export function pressEscapeOn(dialog: HTMLElement): boolean {
  const cancel = new Event('cancel', { cancelable: true });
  fireEvent(dialog, cancel);
  if (!cancel.defaultPrevented) browserCloses(dialog);
  return cancel.defaultPrevented;
}
