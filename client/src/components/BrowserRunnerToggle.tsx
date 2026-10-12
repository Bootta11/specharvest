interface Props {
  /** The user's SpecHarvest extension is connected. */
  online: boolean;
  deviceName: string | null;
  checked: boolean;
  onChange: (on: boolean) => void;
  storeUrl: string | null;
}

/** "Run in my browser": pages load in the user's own Chrome through the SpecHarvest extension. */
export function BrowserRunnerToggle({ online, deviceName, checked, onChange, storeUrl }: Props) {
  return (
    <div className="flex flex-col gap-1">
      <label className={`inline-flex items-center gap-2 text-sm ${online ? "" : "text-stone-500"}`}>
        <input type="checkbox" className="size-4 accent-brand-700" checked={checked} disabled={!online} onChange={(e) => onChange(e.target.checked)} />
        Run in my browser
        <span className={`size-2 rounded-full ${online ? "bg-emerald-500" : "bg-stone-300 dark:bg-stone-600"}`} aria-hidden />
        <span className="sr-only">{online ? "connected" : "not connected"}</span>
      </label>
      <p className="pl-6 text-xs text-stone-500">
        {online ? (
          <>Pages load in {deviceName ?? "your Chrome"} — free, and past most “are you a robot” checks.</>
        ) : (
          <>
            Load pages in your own Chrome with the SpecHarvest extension
            {storeUrl ? (
              <>
                {" "}
                —{" "}
                <a className="text-brand-700 underline dark:text-brand-500" href={storeUrl} target="_blank" rel="noreferrer">
                  get it
                </a>
                , then connect it.
              </>
            ) : (
              <>, connected under your account → Connected browsers.</>
            )}
          </>
        )}
      </p>
    </div>
  );
}
