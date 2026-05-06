import { useEffect, useMemo, useRef, useState } from "react";
import type { EpisodeListItem, EpisodeRecord } from "./types";
import {
  createManualEntry,
  deleteEpisode,
  fetchEpisode,
  fetchEpisodes,
  regenerateMessage,
  reresearchEpisode,
  runEpisode
} from "./api";
import { Check, Search, Trash2, X } from "lucide-react";

function scoreColor(score: number | null) {
  if (score == null) return "text-[color:var(--muted-fg)] border-[color:rgba(26,26,26,0.2)]";
  if (score >= 7) return "text-[#2D6A4F] border-[#2D6A4F]/30";
  if (score >= 4) return "text-[#B7791F] border-[#B7791F]/30";
  return "text-[color:var(--muted-fg)] border-[color:rgba(26,26,26,0.2)]";
}

function statusDot(status: EpisodeListItem["status"]) {
  if (status === "processing") return "bg-[color:var(--gold)] animate-pulse";
  if (status === "complete") return "bg-[#2D6A4F]";
  if (status === "error") return "bg-[#9B2C2C]";
  return "bg-transparent border border-[color:rgba(26,26,26,0.25)]";
}

function groupEpisodes(items: EpisodeListItem[]) {
  const manual = items.filter((i) => i.source === "manual");
  const podcast = items.filter((i) => i.source !== "manual");
  const bySeason = new Map<number, EpisodeListItem[]>();
  for (const ep of podcast) {
    const season = ep.season ?? -1;
    bySeason.set(season, [...(bySeason.get(season) || []), ep]);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => b - a);
  return { manual, seasons, bySeason };
}

function maybeAbsGivingPi(url: string | null) {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return `https://givingpi.org${url}`;
  return url;
}

export function App() {
  const [episodes, setEpisodes] = useState<EpisodeListItem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manualName, setManualName] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<EpisodeRecord | null>(null);
  const [progress, setProgress] = useState<{ step: string; message: string } | null>(null);
  const [composerText, setComposerText] = useState("");
  const [editedInsights, setEditedInsights] = useState<any>(null);
  const [showPrep, setShowPrep] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [iimbContextDraft, setIimbContextDraft] = useState<string>("");
  const [iimbContextLoading, setIimbContextLoading] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const [fatalUiError, setFatalUiError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchEpisodes()
      .then((eps) => {
        if (!alive) return;
        setEpisodes(eps);
        if (!selectedId && eps.length) setSelectedId(eps[0].id);
      })
      .catch((e) => setToast(e.message || "Failed to load episodes"));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const grouped = useMemo(() => groupEpisodes(episodes || []), [episodes]);
  const selected = useMemo(
    () => (episodes || []).find((e) => e.id === selectedId) || null,
    [episodes, selectedId]
  );

  async function reloadEpisodes() {
    const eps = await fetchEpisodes();
    setEpisodes(eps);
    return eps;
  }

  async function loadRecord(id: string) {
    const rec = await fetchEpisode(id);
    setSelectedRecord(rec);
    setComposerText(rec.linkedin_message || "");
    try {
      setEditedInsights(rec.profile_json ? JSON.parse(rec.profile_json) : null);
    } catch {
      setEditedInsights(null);
    }
  }

  async function startAndStream(id: string) {
    esRef.current?.close();
    setProgress({ step: "fetching_sources", message: "Starting..." });

    try {
      await runEpisode(id);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to start pipeline");
      await reloadEpisodes();
      return;
    }

    const es = new EventSource(`/api/episodes/stream/${encodeURIComponent(id)}`);
    esRef.current = es;

    es.addEventListener("status", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { step: string; message: string };
        setProgress({ step: data.step, message: data.message });
      } catch {
        // ignore
      }
    });

    es.addEventListener("complete", async () => {
      es.close();
      setProgress(null);
      await reloadEpisodes();
      await loadRecord(id);
    });

    es.addEventListener("error", async () => {
      es.close();
      setProgress(null);
      await reloadEpisodes();
      setToast("Pipeline error. Open the episode to see details.");
    });
  }

  useEffect(() => {
    if (!selectedId || !episodes) return;
    const ep = episodes.find((e) => e.id === selectedId);
    if (!ep) return;

    setShowPrep(false);
    setSelectedRecord(null);

    if (ep.status === "complete") {
      loadRecord(ep.id).catch(() => setToast("Failed to load profile"));
      return;
    }

    if (ep.status === "pending" || ep.status === "error") {
      startAndStream(ep.id).catch(() => {});
      return;
    }

    // processing: just subscribe
    startAndStream(ep.id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const onErr = (e: ErrorEvent) => {
      setFatalUiError(e.message || "Unknown UI error");
    };
    const onRej = (e: PromiseRejectionEvent) => {
      const msg =
        (e.reason && (e.reason.message || String(e.reason))) || "Unhandled promise rejection";
      setFatalUiError(msg);
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);

  return (
    <div className="min-h-screen">
      <div className="noise-overlay" />

      {/* Desktop gridlines (align to the 3-panel container, not viewport) */}
      <div className="hidden lg:block pointer-events-none">
        <div className="fixed inset-0">
          <div className="mx-8 h-full relative">
            <div
              className="absolute top-0 h-full w-px bg-[color:rgba(26,26,26,0.2)]"
              style={{ left: "33.3333%" }}
            />
            <div
              className="absolute top-0 h-full w-px bg-[color:rgba(26,26,26,0.2)]"
              style={{ left: "66.6666%" }}
            />
          </div>
        </div>
      </div>

      <header className="px-8 pt-8">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-6">
              <div className="font-['Playfair_Display'] text-[11px] tracking-[0.3em] text-[color:var(--gold)]">
                CATALYZING CHANGE
              </div>
              <div className="text-[10px] uppercase tracking-[0.3em] text-[color:var(--muted-fg)]">
                IIMB DEVELOPMENT OFFICE
              </div>
            </div>
            <div className="mt-2 font-['Playfair_Display'] text-4xl text-[color:var(--fg)] leading-[1.05]">
              Prospect
              <br />
              Intelligence
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-3">
            <button
              className="border border-[color:rgba(26,26,26,0.3)] text-[10px] uppercase tracking-[0.2em] px-4 h-8 text-[color:var(--muted-fg)] transition-colors duration-500 hover:border-[color:var(--fg)] hover:text-[color:var(--fg)]"
              onClick={async () => {
                setShowSettings(true);
                setIimbContextLoading(true);
                try {
                  const res = await fetch("/api/settings/iimb-context");
                  const txt = await res.text();
                  setIimbContextDraft(txt);
                } finally {
                  setIimbContextLoading(false);
                }
              }}
            >
              Settings
            </button>
          </div>
        </div>

        <div className="mt-8 h-px w-full bg-[color:rgba(26,26,26,0.2)]" />
      </header>

      <main className="px-8 pb-10">
        <div className={["grid grid-cols-1 lg:grid-cols-3 gap-0", showPrep ? "lg:grid-cols-2" : ""].join(" ")}>
          {/* Left panel */}
          <section className="lg:pr-8 lg:border-r lg:border-[color:rgba(26,26,26,0.1)]">
            <div className="pt-8">
              <div className="flex items-center gap-3 border-b border-[color:var(--fg)]">
                <input
                  className="w-full bg-transparent px-0 py-2 outline-none text-sm font-['Inter'] text-[color:var(--fg)] placeholder:font-['Playfair_Display'] placeholder:italic placeholder:text-[color:var(--muted-fg)]"
                  placeholder="Search any name..."
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    const name = manualName.trim();
                    if (!name) return;
                    setToast("Starting manual research...");
                    createManualEntry(name)
                      .then(async ({ id }) => {
                        setManualName("");
                        await reloadEpisodes();
                        setSelectedId(id);
                      })
                      .catch((err) => setToast(err instanceof Error ? err.message : "Manual search failed"));
                  }}
                />
                <button
                  className="p-2 text-[color:var(--muted-fg)] hover:text-[color:var(--gold)] transition-colors duration-500"
                  onClick={() => {
                    const name = manualName.trim();
                    if (!name) return;
                    setToast("Starting manual research...");
                    createManualEntry(name)
                      .then(async ({ id }) => {
                        setManualName("");
                        await reloadEpisodes();
                        setSelectedId(id);
                      })
                      .catch((err) => setToast(err instanceof Error ? err.message : "Manual search failed"));
                  }}
                  aria-label="Search"
                >
                  <Search size={18} strokeWidth={1.5} />
                </button>
              </div>
            </div>

            <div className="pt-8">
              {episodes == null ? (
                <div className="text-sm text-[color:var(--muted-fg)]">Loading…</div>
              ) : (
                <div>
                  <div className="mb-8">
                    <div className="text-[10px] uppercase tracking-[0.3em] text-[color:var(--muted-fg)]">
                      MANUAL SEARCHES
                    </div>
                    <div className="mt-3">
                      {(episodes || []).map((ep) => (
                        <EpisodeRow
                          key={ep.id}
                          ep={ep}
                          selected={ep.id === selectedId}
                          onClick={() => setSelectedId(ep.id)}
                        />
                      ))}
                      {!episodes?.length && (
                        <div className="mt-6 text-sm text-[color:var(--muted-fg)]">
                          Type a name above to begin.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Centre panel */}
          <section className="lg:px-8 lg:border-r lg:border-[color:rgba(26,26,26,0.1)]">
            <div className="pt-8">
              {selected ? (
                <div>
                  <div className="font-['Playfair_Display'] text-3xl text-[color:var(--fg)]">
                    {selected.guest_name || selected.episode_title || "Untitled"}
                  </div>
                  <div className="mt-2 text-sm text-[color:var(--muted-fg)] font-['Inter']">
                    {selected.organisation || "—"}
                  </div>
                  <div className="mt-6 h-px w-full bg-[color:rgba(26,26,26,0.1)]" />

                  {progress ? (
                    <div className="mt-10">
                      <div className="text-sm font-['Inter'] text-[color:var(--muted-fg)] transition-opacity duration-700">
                        {progress.message}
                      </div>
                      <div className="mt-6 h-px w-full bg-[color:rgba(212,175,55,0.35)]" />
                      <div className="mt-2 h-[2px] w-full bg-[color:rgba(26,26,26,0.08)]">
                        <div
                          className="h-[2px] bg-[color:var(--gold)] transition-all duration-700"
                          style={{
                            width:
                              progress.step === "fetching_sources"
                                ? "20%"
                                : progress.step === "searching"
                                  ? "40%"
                                  : progress.step === "reading"
                                    ? "60%"
                                    : progress.step === "extracting"
                                      ? "80%"
                                      : progress.step === "drafting"
                                        ? "95%"
                                        : "10%"
                          }}
                        />
                      </div>
                    </div>
                  ) : editedInsights ? (
                    <div className="mt-10">
                      <Field
                        label="Origin Story"
                        value={editedInsights.origin_story || ""}
                        onChange={(v) => setEditedInsights({ ...editedInsights, origin_story: v })}
                        multiline
                      />
                      <div className="mt-8" />
                      <Field
                        label="Core Thesis"
                        value={editedInsights.core_thesis || ""}
                        onChange={(v) => setEditedInsights({ ...editedInsights, core_thesis: v })}
                        multiline
                      />
                      <div className="mt-8" />
                      <div className="text-[10px] uppercase tracking-[0.25em] text-[color:var(--muted-fg)]">
                        Best Quote
                      </div>
                      <textarea
                        className="mt-3 w-full bg-transparent outline-none border-l-2 border-[color:var(--gold)] pl-4 font-['Playfair_Display'] italic text-sm leading-relaxed border-b border-transparent focus:border-b focus:border-[color:var(--gold)] transition-colors duration-500"
                        value={editedInsights.best_quote || ""}
                        onChange={(e) => setEditedInsights({ ...editedInsights, best_quote: e.target.value })}
                      />

                      <div className="mt-8" />
                      <div className="text-[10px] uppercase tracking-[0.25em] text-[color:var(--muted-fg)]">
                        Vocabulary
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 items-center">
                        {(editedInsights.vocabulary || []).map((w: string, idx: number) => (
                          <button
                            key={`${w}-${idx}`}
                            className="text-[10px] uppercase tracking-[0.15em] border border-[color:rgba(26,26,26,0.2)] px-2 py-1 hover:border-[color:var(--gold)] transition-colors duration-500"
                            onClick={() => {
                              const next = [...(editedInsights.vocabulary || [])];
                              next.splice(idx, 1);
                              setEditedInsights({ ...editedInsights, vocabulary: next });
                            }}
                            title="Remove"
                          >
                            {w}
                          </button>
                        ))}
                        <button
                          className="text-[10px] uppercase tracking-[0.15em] border border-[color:rgba(26,26,26,0.2)] px-2 py-1 text-[color:var(--muted-fg)] hover:text-[color:var(--gold)] hover:border-[color:var(--gold)] transition-colors duration-500"
                          onClick={() => {
                            const v = window.prompt("Add vocabulary phrase");
                            const phrase = (v || "").trim();
                            if (!phrase) return;
                            const next = [...(editedInsights.vocabulary || []), phrase];
                            setEditedInsights({ ...editedInsights, vocabulary: next });
                          }}
                          title="Add"
                        >
                          +
                        </button>
                      </div>

                      <div className="mt-8" />
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.25em] text-[color:var(--muted-fg)]">
                            Giving Style
                          </div>
                          <select
                            className="mt-3 w-full bg-transparent outline-none border-b border-transparent focus:border-[color:var(--gold)] text-sm font-['Inter']"
                            value={editedInsights.giving_style || ""}
                            onChange={(e) =>
                              setEditedInsights({ ...editedInsights, giving_style: e.target.value })
                            }
                          >
                            <option value="">—</option>
                            <option value="personal giving">personal giving</option>
                            <option value="family foundation">family foundation</option>
                            <option value="institution-building">institution-building</option>
                            <option value="knowledge philanthropy">knowledge philanthropy</option>
                            <option value="diaspora giving">diaspora giving</option>
                            <option value="corporate CSR">corporate CSR</option>
                            <option value="board-level strategy">board-level strategy</option>
                          </select>
                        </div>

                        <div>
                          <div className="text-[10px] uppercase tracking-[0.25em] text-[color:var(--muted-fg)]">
                            Estimated Capacity
                          </div>
                          <select
                            className="mt-3 w-full bg-transparent outline-none border-b border-transparent focus:border-[color:var(--gold)] text-sm font-['Inter']"
                            value={editedInsights.estimated_capacity || ""}
                            onChange={(e) =>
                              setEditedInsights({ ...editedInsights, estimated_capacity: e.target.value })
                            }
                          >
                            <option value="">—</option>
                            <option value="exploratory">exploratory</option>
                            <option value="mid-tier">mid-tier</option>
                            <option value="major donor potential">major donor potential</option>
                          </select>
                        </div>
                      </div>

                      <div className="mt-8" />
                      <div>
                        <div className="flex items-baseline justify-between gap-6">
                          <div className="text-[10px] uppercase tracking-[0.25em] text-[color:var(--muted-fg)]">
                            IIMB Alignment
                          </div>
                          <div className="text-sm font-['Inter'] font-medium text-[color:var(--fg)]">
                            {(typeof editedInsights.iimb_alignment_score === "number"
                              ? editedInsights.iimb_alignment_score
                              : 0) + "/10"}
                          </div>
                        </div>
                        <div className="mt-3 h-[2px] w-full bg-[color:rgba(26,26,26,0.08)]">
                          <div
                            className="h-[2px] bg-[color:var(--gold)] transition-all duration-500"
                            style={{
                              width:
                                typeof editedInsights.iimb_alignment_score === "number"
                                  ? `${Math.max(0, Math.min(10, editedInsights.iimb_alignment_score)) * 10}%`
                                  : "0%"
                            }}
                          />
                        </div>
                      </div>

                      <div className="mt-8" />
                      <Field
                        label="IIMB Alignment Reasoning"
                        value={editedInsights.iimb_alignment_reasoning || ""}
                        onChange={(v) =>
                          setEditedInsights({ ...editedInsights, iimb_alignment_reasoning: v })
                        }
                        multiline
                      />

                      <div className="mt-8" />
                      <Field
                        label="Capacity Reasoning"
                        value={editedInsights.capacity_reasoning || ""}
                        onChange={(v) => setEditedInsights({ ...editedInsights, capacity_reasoning: v })}
                        multiline
                      />

                      <div className="mt-8" />
                      <Field
                        label="Warm Path"
                        value={editedInsights.warm_path || ""}
                        onChange={(v) => setEditedInsights({ ...editedInsights, warm_path: v })}
                        multiline
                      />

                      <div className="mt-10 h-px w-full bg-[color:rgba(26,26,26,0.1)]" />
                      <button
                        className="mt-8 w-full border border-[color:var(--fg)] text-[10px] uppercase tracking-[0.2em] px-6 h-12 transition-colors duration-500 hover:bg-[color:var(--fg)] hover:text-[color:var(--white)]"
                        onClick={() => setShowPrep(true)}
                      >
                        Conversation Prep ↓
                      </button>
                      <button
                        className="mt-4 text-[10px] uppercase tracking-[0.2em] text-[color:var(--muted-fg)] hover:text-[color:var(--gold)] transition-colors duration-500"
                        onClick={async () => {
                          if (!selectedId) return;
                          setToast("Re-running research...");
                          await reresearchEpisode(selectedId).catch((e) =>
                            setToast(e instanceof Error ? e.message : "Re-research failed")
                          );
                          await reloadEpisodes();
                          setProgress({ step: "fetching_sources", message: "Starting..." });
                        }}
                      >
                        Re-research
                      </button>
                    </div>
                  ) : (
                    <div className="mt-10 text-sm text-[color:var(--muted-fg)] font-['Inter']">
                      {selected.status === "error"
                        ? "An error occurred. Try Re-research."
                        : "Select an episode to begin."}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-sm text-[color:var(--muted-fg)]">Select an episode…</div>
              )}
            </div>
          </section>

          {/* Right panel */}
          {!showPrep && (
            <section className="lg:pl-8">
            <div className="pt-8">
              <div className="text-[10px] uppercase tracking-[0.25em] text-[color:var(--muted-fg)]">
                Outreach Composer
              </div>
              <textarea
                className="mt-4 w-full min-h-[220px] resize-none bg-transparent outline-none border-b border-[color:rgba(26,26,26,0.2)] pb-4 text-sm leading-relaxed font-['Inter']"
                placeholder="LinkedIn message will appear here…"
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
              />
              <div
                className={[
                  "mt-2 text-[10px]",
                  composerText.trim().split(/\s+/).filter(Boolean).length > 150
                    ? "text-[color:var(--gold)]"
                    : "text-[color:var(--muted-fg)]"
                ].join(" ")}
              >
                {composerText.trim().length
                  ? composerText.trim().split(/\s+/).filter(Boolean).length
                  : 0}{" "}
                / 150 words
              </div>

              <div className="mt-8 space-y-4">
                <button
                  className="btn-primary w-full h-12 text-xs uppercase tracking-[0.2em] font-medium disabled:opacity-50 disabled:pointer-events-none"
                  disabled={!selectedId || !editedInsights || regenerating}
                  onClick={async () => {
                    if (!selectedId || !editedInsights) return;
                    setRegenerating(true);
                    try {
                      const r = await regenerateMessage(selectedId, editedInsights);
                      setComposerText(r.message);
                      await loadRecord(selectedId);
                      setToast("Message regenerated.");
                    } catch (e) {
                      setToast(e instanceof Error ? e.message : "Regenerate failed");
                    } finally {
                      setRegenerating(false);
                    }
                  }}
                >
                  <span>{regenerating ? "Regenerating…" : "Regenerate Message"}</span>
                </button>
                {regenerating && (
                  <div className="h-[2px] w-full bg-[color:rgba(26,26,26,0.08)]">
                    <div className="h-[2px] w-[45%] bg-[color:var(--gold)] animate-pulse" />
                  </div>
                )}
                <button
                  className="w-full h-12 border border-[color:var(--fg)] text-xs uppercase tracking-[0.2em] transition-colors duration-500 hover:bg-[color:var(--fg)] hover:text-[color:var(--white)]"
                  onClick={async () => {
                    await navigator.clipboard.writeText(composerText || "");
                    setToast("Copied ✓");
                  }}
                >
                  Copy to Clipboard
                </button>
                <button
                  className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted-fg)] hover:text-[color:var(--gold)] transition-colors duration-500"
                  onClick={() => {
                    const q = encodeURIComponent(selected?.guest_name || selected?.episode_title || "");
                    window.open(`https://www.linkedin.com/search/results/people/?keywords=${q}`, "_blank");
                  }}
                >
                  Open LinkedIn ↗
                </button>
              </div>

              {selectedRecord && (selectedRecord.linkedin_message_v2 || selectedRecord.linkedin_message_v3) && (
                <div className="mt-10">
                  <div className="text-[10px] uppercase tracking-[0.25em] text-[color:var(--muted-fg)]">
                    Previous Versions
                  </div>
                  <div className="mt-4 space-y-2 text-sm font-['Inter']">
                    {selectedRecord.linkedin_message_v2 && (
                      <button
                        className="block text-left text-[color:var(--muted-fg)] hover:text-[color:var(--gold)] transition-colors duration-500"
                        onClick={() => setComposerText(selectedRecord.linkedin_message_v2 || "")}
                      >
                        v2
                      </button>
                    )}
                    {selectedRecord.linkedin_message_v3 && (
                      <button
                        className="block text-left text-[color:var(--muted-fg)] hover:text-[color:var(--gold)] transition-colors duration-500"
                        onClick={() => setComposerText(selectedRecord.linkedin_message_v3 || "")}
                      >
                        v3
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
          )}
        </div>
      </main>

      {/* Conversation prep panel (spec: pushes composer off-screen on desktop) */}
      {showPrep && editedInsights?.conversation_prep && (
        <div className="fixed inset-0 z-40">
          <div
            className="absolute inset-0 bg-black/10"
            onClick={() => setShowPrep(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-0 h-full w-full max-w-[560px] bg-[color:var(--bg)] border-l border-[color:rgba(26,26,26,0.1)] p-8 overflow-auto transition-transform duration-500">
            <div className="font-['Playfair_Display'] italic text-2xl">Conversation Prep</div>
            <div className="mt-6 text-[10px] uppercase tracking-[0.3em] text-[color:var(--muted-fg)]">
              Talking Points
            </div>
            <div className="mt-4 space-y-4">
              {(editedInsights.conversation_prep.three_talking_points || []).map((t: string, i: number) => (
                <div key={i} className="flex gap-4">
                  <div className="font-['Playfair_Display'] text-3xl text-[color:var(--gold)] leading-none">
                    {i + 1}
                  </div>
                  <div className="text-sm leading-relaxed font-['Inter']">{t}</div>
                </div>
              ))}
            </div>

            <div className="mt-10 h-px bg-[color:rgba(26,26,26,0.1)]" />
            <div className="mt-8 text-[10px] uppercase tracking-[0.3em] text-[color:var(--muted-fg)]">
              Questions to Ask
            </div>
            <div className="mt-4 space-y-4">
              {(editedInsights.conversation_prep.questions_to_ask || []).map((q: string, i: number) => (
                <div
                  key={i}
                  className="border-l-2 border-[color:var(--gold)] pl-4 font-['Playfair_Display'] italic text-sm leading-relaxed"
                >
                  {q}
                </div>
              ))}
            </div>

            <div className="mt-10 h-px bg-[color:rgba(26,26,26,0.1)]" />
            <div className="mt-8 text-[10px] uppercase tracking-[0.3em] text-[color:var(--muted-fg)]">
              Things to Avoid
            </div>
            <div className="mt-4 space-y-2 text-sm font-['Inter'] text-[color:var(--muted-fg)]">
              {(editedInsights.conversation_prep.things_to_avoid || []).map((x: string, i: number) => (
                <div key={i}>− {x}</div>
              ))}
            </div>

            <div className="mt-10 h-px bg-[color:rgba(26,26,26,0.1)]" />
            <div className="mt-8 text-[10px] uppercase tracking-[0.3em] text-[color:var(--muted-fg)]">
              Shared Context
            </div>
            <div className="mt-4 text-sm leading-relaxed font-['Inter']">
              {editedInsights.conversation_prep.shared_context || "—"}
            </div>

            <div className="mt-10 h-px bg-[color:rgba(26,26,26,0.1)]" />
            <div className="mt-8 text-[10px] uppercase tracking-[0.3em] text-[color:var(--muted-fg)]">
              Their Likely Ask
            </div>
            <div className="mt-4 bg-[color:var(--muted-bg)] p-6 font-['Playfair_Display'] italic text-sm">
              {editedInsights.conversation_prep.their_ask || "—"}
            </div>

            <div className="mt-10 flex items-center justify-between">
              <button
                className="border border-[color:var(--fg)] text-[10px] uppercase tracking-[0.2em] px-6 h-10 transition-colors duration-500 hover:bg-[color:var(--fg)] hover:text-[color:var(--white)]"
                onClick={async () => {
                  const text = [
                    "TALKING POINTS",
                    ...(editedInsights.conversation_prep.three_talking_points || []).map(
                      (t: string, i: number) => `${i + 1}. ${t}`
                    ),
                    "",
                    "QUESTIONS TO ASK",
                    ...(editedInsights.conversation_prep.questions_to_ask || []).map((q: string) => `- ${q}`),
                    "",
                    "THINGS TO AVOID",
                    ...(editedInsights.conversation_prep.things_to_avoid || []).map((x: string) => `- ${x}`),
                    "",
                    "SHARED CONTEXT",
                    editedInsights.conversation_prep.shared_context || "",
                    "",
                    "THEIR LIKELY ASK",
                    editedInsights.conversation_prep.their_ask || ""
                  ].join("\n");
                  await navigator.clipboard.writeText(text);
                  setToast("Copied ✓");
                }}
              >
                Copy All
              </button>
              <button
                className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted-fg)] hover:text-[color:var(--gold)] transition-colors duration-500"
                onClick={() => setShowPrep(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 border border-[color:rgba(26,26,26,0.2)] bg-[color:var(--bg)] px-4 py-2 text-xs uppercase tracking-[0.2em]">
          {toast}
        </div>
      )}

      {fatalUiError && (
        <div className="fixed bottom-6 right-6 max-w-[420px] border border-[color:rgba(26,26,26,0.2)] bg-[color:var(--bg)] px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.25em] text-[color:var(--muted-fg)]">
            UI Error
          </div>
          <div className="mt-2 text-sm font-['Inter']">{fatalUiError}</div>
          <button
            className="mt-3 text-[10px] uppercase tracking-[0.2em] text-[color:var(--muted-fg)] hover:text-[color:var(--gold)] transition-colors duration-500"
            onClick={() => setFatalUiError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {showSettings && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/20"
            onClick={() => setShowSettings(false)}
            aria-hidden="true"
          />
          <div className="absolute left-1/2 top-10 w-[min(900px,calc(100vw-48px))] -translate-x-1/2 border border-[color:rgba(26,26,26,0.2)] bg-[color:var(--bg)] p-8">
            <div className="flex items-center justify-between gap-6">
              <div>
                <div className="font-['Playfair_Display'] text-2xl">Settings</div>
                <div className="mt-1 text-[10px] uppercase tracking-[0.25em] text-[color:var(--muted-fg)]">
                  IIMB context injected into prompts
                </div>
              </div>
              <button
                className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted-fg)] hover:text-[color:var(--gold)] transition-colors duration-500"
                onClick={() => setShowSettings(false)}
              >
                Close
              </button>
            </div>

            <div className="mt-6">
              <textarea
                className="w-full h-[50vh] bg-transparent outline-none border border-[color:rgba(26,26,26,0.2)] p-4 font-['Inter'] text-sm leading-relaxed"
                value={iimbContextLoading ? "Loading…" : iimbContextDraft}
                onChange={(e) => setIimbContextDraft(e.target.value)}
                disabled={iimbContextLoading}
              />
            </div>

            <div className="mt-6 flex items-center justify-between">
              <button
                className="border border-[color:var(--fg)] text-[10px] uppercase tracking-[0.2em] px-6 h-10 transition-colors duration-500 hover:bg-[color:var(--fg)] hover:text-[color:var(--white)] disabled:opacity-50"
                disabled={iimbContextLoading}
                onClick={async () => {
                  try {
                    const res = await fetch("/api/settings/iimb-context", {
                      method: "PUT",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ content: iimbContextDraft })
                    });
                    if (!res.ok) throw new Error("Save failed");
                    setToast("Saved.");
                  } catch (e) {
                    setToast(e instanceof Error ? e.message : "Save failed");
                  }
                }}
              >
                Save
              </button>
              <div className="text-[10px] uppercase tracking-[0.2em] text-[color:var(--muted-fg)]">
                Stored in `data/iimb-context.md`
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  function EpisodeRow({
    ep,
    selected,
    onClick
  }: {
    ep: EpisodeListItem;
    selected: boolean;
    onClick: () => void;
  }) {
    return (
      <button
        onClick={onClick}
        className={[
          "group w-full text-left py-4 border-t transition-colors duration-500",
          selected
            ? "border-t-[color:var(--fg)] bg-[color:rgba(235,229,222,0.5)]"
            : "border-t-[color:rgba(26,26,26,0.1)] hover:bg-[color:rgba(235,229,222,0.3)]"
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex items-start gap-3">
            {/* Spec: episode list is text-first; avoid thumbnails dominating layout */}
            <div className="shrink-0 w-2" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className={["h-2 w-2 rounded-full", statusDot(ep.status)].join(" ")} />
                {ep.status === "complete" && <Check size={14} strokeWidth={1.5} />}
                {ep.status === "error" && <X size={14} strokeWidth={1.5} />}
                <div className="font-['Inter'] font-medium text-[14px] text-[color:var(--fg)] truncate">
                  {ep.guest_name || ep.episode_title || "Untitled"}
                </div>
              </div>
              <div className="mt-1 font-['Inter'] text-[12px] text-[color:var(--muted-fg)] truncate">
                {ep.organisation || "—"}
              </div>
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-3">
            <button
              className="text-[color:var(--muted-fg)] hover:text-[color:var(--gold)] transition-colors duration-500"
              title="Remove permanently"
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const name = ep.guest_name || ep.episode_title || "this person";
                if (!window.confirm(`Remove ${name} permanently?`)) return;
                try {
                  await deleteEpisode(ep.id);
                  const next = await reloadEpisodes();
                  if (selectedId === ep.id) {
                    setSelectedId(next[0]?.id || null);
                    setSelectedRecord(null);
                    setEditedInsights(null);
                    setComposerText("");
                  }
                  setToast("Removed.");
                } catch (err) {
                  setToast(err instanceof Error ? err.message : "Remove failed");
                }
              }}
              aria-label="Remove permanently"
            >
              <Trash2 size={16} strokeWidth={1.5} />
            </button>

            <div
              className={[
                "shrink-0 text-[10px] border px-2 py-1 font-['Inter']",
                scoreColor(ep.iimb_alignment_score)
              ].join(" ")}
            >
              {ep.iimb_alignment_score ?? "—"}
            </div>
          </div>
        </div>
      </button>
    );
  }
}

function Field({
  label,
  value,
  onChange,
  multiline
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.25em] text-[color:var(--muted-fg)]">{label}</div>
      {multiline ? (
        <textarea
          className="mt-3 w-full bg-transparent outline-none text-sm leading-relaxed font-['Inter'] border-b border-transparent focus:border-[color:var(--gold)] transition-colors duration-500"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="mt-3 w-full bg-transparent outline-none text-sm leading-relaxed font-['Inter'] border-b border-transparent focus:border-[color:var(--gold)] transition-colors duration-500"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

