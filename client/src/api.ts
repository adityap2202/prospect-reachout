import type { EpisodeListItem } from "./types";
import type { EpisodeRecord } from "./types";

export async function fetchEpisodes(): Promise<EpisodeListItem[]> {
  const res = await fetch("/api/episodes");
  if (!res.ok) throw new Error("Failed to load episodes");
  return (await res.json()) as EpisodeListItem[];
}

export async function refreshEpisodes(): Promise<{ new_episodes: number }> {
  const res = await fetch("/api/episodes/refresh", { method: "POST" });
  if (!res.ok) throw new Error("Failed to refresh episodes");
  return (await res.json()) as { new_episodes: number };
}

export async function createManualEntry(name: string): Promise<{ id: string }> {
  const res = await fetch("/api/manual", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!res.ok) throw new Error("Failed to create manual entry");
  return (await res.json()) as { id: string };
}

export async function fetchEpisode(id: string): Promise<EpisodeRecord> {
  const res = await fetch(`/api/episodes/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error("Failed to load profile");
  return (await res.json()) as EpisodeRecord;
}

export async function runEpisode(id: string): Promise<void> {
  const res = await fetch(`/api/episodes/run/${encodeURIComponent(id)}`, { method: "POST" });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(j?.error || "Failed to start pipeline");
  }
}

export async function reresearchEpisode(id: string): Promise<void> {
  const res = await fetch(`/api/episodes/${encodeURIComponent(id)}/reresearch`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to re-run pipeline");
}

export async function regenerateMessage(id: string, insights: unknown): Promise<{ message: string }> {
  const res = await fetch(`/api/episodes/${encodeURIComponent(id)}/regenerate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ insights })
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(j?.error || "Failed to regenerate message");
  }
  return (await res.json()) as { message: string };
}

export async function deleteEpisode(id: string): Promise<void> {
  const res = await fetch(`/api/episodes/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(j?.error || "Failed to delete");
  }
}


