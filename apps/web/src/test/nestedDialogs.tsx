// The page e2e/dialogNested.spec.ts drives: a dialog drawn inside another one, which no screen of the
// app does. The spec builds it with the app's own ui/dialog.tsx; nothing in the app imports it.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/** What each owner was asked, and what was shown, for the spec to read. */
const seen = { asked: [] as string[], shown: 0 };
Object.assign(window, { seen });
const { showModal } = HTMLDialogElement.prototype;
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  seen.shown += 1;
  showModal.call(this);
};

function Page(props: { guardOuter: boolean; guardInner: boolean }) {
  const [outer, setOuter] = useState(false);
  const [shown, setShown] = useState(true);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setShown(true);
          setOuter(true);
        }}
      >
        Open the outer
      </button>
      {shown ? (
        <Dialog
          open={outer}
          onOpenChange={(next) => {
            seen.asked.push('outer');
            setOuter(next);
          }}
        >
          <DialogContent guardClose={props.guardOuter}>
            <DialogTitle>Outer</DialogTitle>
            <label>
              Pasted <input />
            </label>
            <Inner
              guard={props.guardInner}
              onCloseOuter={() => setOuter(false)}
              onTakeOuterOut={() => setShown(false)}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function Inner(props: { guard: boolean; onCloseOuter: () => void; onTakeOuterOut: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open the inner
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          seen.asked.push('inner');
          setOpen(next);
        }}
      >
        <DialogContent guardClose={props.guard}>
          <DialogTitle>Inner</DialogTitle>
          <button type="button" onClick={props.onCloseOuter}>
            Close the outer
          </button>
          <button type="button" onClick={props.onTakeOuterOut}>
            Take the outer out
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}

const root = document.getElementById('root');
if (root !== null) {
  const q = new URLSearchParams(location.search);
  createRoot(root).render(<Page guardOuter={q.has('outer')} guardInner={q.has('inner')} />);
}
