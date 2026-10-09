import { useState, type FormEvent } from "react";
import type { Collection, CollectionGroup } from "@specharvest/shared";
import { api } from "../lib/api.ts";
import { Field, Modal, Notice } from "./Modal.tsx";

/** Create a group (no `group`) or edit one: a name and the collections searched together. */
export function GroupModal({ group, collections, onSaved, onClose }: { group: CollectionGroup | null; collections: Collection[]; onSaved: () => void; onClose: () => void }) {
  const [name, setName] = useState(group?.name ?? "");
  const [picked, setPicked] = useState<Set<number>>(() => new Set(group?.collectionIds ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: number, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const items = collections.filter((c) => picked.has(c.id)).reduce((n, c) => n + c.itemCount, 0);
  const canSave = name.trim().length > 0 && picked.size > 0 && !busy;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), collectionIds: [...picked] };
      if (group) await api.updateGroup(group.id, body);
      else await api.createGroup(body);
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={group ? `Edit group "${group.name}"` : "New group"} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <Field label="Name">
          <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cars" maxLength={200} autoFocus />
        </Field>
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-stone-600 dark:text-stone-400">Collections searched together</legend>
          <ul className="max-h-72 divide-y divide-stone-200 overflow-y-auto rounded-lg border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
            {collections.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-stone-50 dark:hover:bg-stone-800/50">
                  <input type="checkbox" className="size-4 shrink-0 accent-brand-700" checked={picked.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" title={c.name}>
                      {c.name}
                    </span>
                    <span className="block truncate text-xs text-stone-500">
                      {c.itemCount} items · {c.host}
                      {!c.canEdit && c.isShared && <> · shared by {c.ownerEmail ?? "another user"}</>}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-stone-500">
            {picked.size} selected · {items} items. Only you see this group.
          </p>
        </fieldset>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!canSave}>
            {busy ? "Saving…" : group ? "Save" : "Create group"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
