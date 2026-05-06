export type EpisodeStatus = "pending" | "processing" | "complete" | "error";
export type EpisodeSource = "podcast" | "manual";

export type EpisodeListItem = {
  id: string;
  source: EpisodeSource;
  season: number | null;
  episode_title: string | null;
  guest_name: string | null;
  organisation: string | null;
  status: EpisodeStatus;
  iimb_alignment_score: number | null;
  thumbnail_url: string | null;
  published_date: string | null;
};

export type EpisodeRecord = {
  id: string;
  source: EpisodeSource;
  rss_guid: string | null;
  moneycontrol_url: string | null;
  givingpi_url: string | null;
  episode_title: string | null;
  episode_description: string | null;
  season: number | null;
  published_date: string | null;
  thumbnail_url: string | null;
  guest_name: string | null;
  organisation: string | null;
  status: EpisodeStatus;
  error_message: string | null;
  profile_json: string | null;
  linkedin_message: string | null;
  linkedin_message_v2: string | null;
  linkedin_message_v3: string | null;
  processed_at: string | null;
  created_at: string;
};

