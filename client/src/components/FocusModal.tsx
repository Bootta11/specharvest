import { useState, type FormEvent } from "react";
import { FOCUS_MAX_LENGTH, type Collection, type Job } from "@specharvest/shared";
import { api } from "../lib/api.ts";
import { Field, Modal, Notice } from "./Modal.tsx";

export const FOCUS_PLACEHOLDER = 'e.g. "first owner cars" or "full service history"';

/**
 * Edit what a collection's crawls look for, and (paid, only on click) check its saved items against it from their
 * stored page text.
 */
export function FocusModal({ collection, onSaved, onStarted, onClose }: { collection: Collection; onSaved: () => void; onStarted: (job: Job) => void; onClose: () => void }) {
  const [current, setCurrent] = useState(collection);
  const [focus, setFocus] = useState(collection.focus ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const changed = focus.trim() !== (current.focus ?? "");

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed || busy) return;
    if (current.focus && current.itemCount > 0 && !window.confirm("Change the focus? The items' answers to the old one are cleared; you can check them against the new one afterwards.")) return;
    setBusy(true);
    setError(null);
    try {
      setCurrent(await api.setCollectionFocus(current.id, focus.trim()));
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.applyFocus(current.id);
      if (res.job) {
        onStarted(res.job);
        onClose();
      } else setNote(res.note ?? "Nothing to check");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pending = changed ? 0 : current.focusPendingCount;
  return (
    <Modal title={`Focus · ${current.name}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <Field
          label="What to look for"
          hint="Every crawl of this collection reads each ad for this and marks it as matching, not matching or not stated, with a quote from the ad. All ads are still saved; filter by “Matches focus” when searching. Leave empty for no focus."
        >
          <textarea
            className="input min-h-20 w-full"
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder={FOCUS_PLACEHOLDER}
            maxLength={FOCUS_MAX_LENGTH}
            autoFocus
          />
        </Field>
        {error && <Notice kind="error">{error}</Notice>}
        {note && <Notice kind="ok">{note}</Notice>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn-primary btn-sm" disabled={!changed || busy}>
            {focus.trim() ? "Save focus" : "Remove focus"}
          </button>
          {pending > 0 && (
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={busy}
              onClick={apply}
              title="One small AI call per ad, from the page text already saved — no pages are loaded again"
            >
              Apply focus to {pending} saved item{pending === 1 ? "" : "s"}
            </button>
          )}
        </div>
        {pending > 0 && <p className="text-xs text-stone-500">Checking saved items uses the LLM (one small call each) and only starts when you click.</p>}
      </form>
    </Modal>
  );
}
