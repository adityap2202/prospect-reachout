const { v4: uuidv4 } = require("uuid");

function upsertEpisode(db, e) {
  const id = e.id || uuidv4();

  const existing = e.moneycontrol_url
    ? db
        .prepare(
          "SELECT id, episode_title, episode_description, season, published_date, thumbnail_url, guest_name, organisation, rss_guid, givingpi_url FROM episodes WHERE moneycontrol_url = ? LIMIT 1"
        )
        .get(e.moneycontrol_url)
    : null;

  if (existing) {
    const patch = {};
    const mergeIfMissing = (key, val) => {
      if ((existing[key] == null || existing[key] === "") && val != null && val !== "") patch[key] = val;
    };
    const updateIfChanged = (key, val) => {
      if (val == null || val === "") return;
      if (existing[key] !== val) patch[key] = val;
    };

    // For podcast source, treat GivingPi/RSS fields as canonical and allow updates.
    const isPodcast = (existing.source || e.source) === "podcast";

    if (isPodcast) {
      updateIfChanged("episode_title", e.episode_title || null);
      updateIfChanged("episode_description", e.episode_description || null);
      updateIfChanged("season", e.season ?? null);
      updateIfChanged("published_date", e.published_date || null);
      updateIfChanged("thumbnail_url", e.thumbnail_url || null);
      updateIfChanged("guest_name", e.guest_name || null);
      updateIfChanged("organisation", e.organisation || null);
      mergeIfMissing("rss_guid", e.rss_guid || null);
      mergeIfMissing("givingpi_url", e.givingpi_url || null);
    } else {
      mergeIfMissing("episode_title", e.episode_title || null);
      mergeIfMissing("episode_description", e.episode_description || null);
      mergeIfMissing("season", e.season ?? null);
      mergeIfMissing("published_date", e.published_date || null);
      mergeIfMissing("thumbnail_url", e.thumbnail_url || null);
      mergeIfMissing("guest_name", e.guest_name || null);
      mergeIfMissing("organisation", e.organisation || null);
      mergeIfMissing("rss_guid", e.rss_guid || null);
      mergeIfMissing("givingpi_url", e.givingpi_url || null);
    }

    const fields = Object.keys(patch);
    if (fields.length) {
      const sets = fields.map((k) => `${k} = @${k}`).join(", ");
      db.prepare(`UPDATE episodes SET ${sets} WHERE id = @id`).run({ id: existing.id, ...patch });
    }

    return { id: existing.id, inserted: false };
  }

  db.prepare(
    `
    INSERT INTO episodes (
      id, source, rss_guid, moneycontrol_url, givingpi_url,
      episode_title, episode_description, season, published_date, thumbnail_url,
      guest_name, organisation, status
    ) VALUES (
      @id, @source, @rss_guid, @moneycontrol_url, @givingpi_url,
      @episode_title, @episode_description, @season, @published_date, @thumbnail_url,
      @guest_name, @organisation, COALESCE(@status, 'pending')
    )
  `
  ).run({
    id,
    source: e.source,
    rss_guid: e.rss_guid || null,
    moneycontrol_url: e.moneycontrol_url || null,
    givingpi_url: e.givingpi_url || null,
    episode_title: e.episode_title || null,
    episode_description: e.episode_description || null,
    season: e.season ?? null,
    published_date: e.published_date || null,
    thumbnail_url: e.thumbnail_url || null,
    guest_name: e.guest_name || null,
    organisation: e.organisation || null,
    status: e.status || "pending"
  });

  return { id, inserted: true };
}

function listEpisodes(db) {
  // Manual first, then seasons DESC, then created_at DESC as a proxy.
  // (Spec mentions "episode DESC"; GivingPi doesn’t expose episode number reliably.)
  const rows = db
    .prepare(
      `
      SELECT
        id, source, season, episode_title, guest_name, organisation, status,
        thumbnail_url, published_date, moneycontrol_url, episode_description,
        profile_json
      FROM episodes
      ORDER BY
        CASE WHEN source = 'manual' THEN 0 ELSE 1 END ASC,
        COALESCE(season, -1) DESC,
        datetime(created_at) DESC
    `
    )
    .all();

  // Add alignment score without storing as a separate column.
  return rows.map((r) => {
    let score = null;
    if (r.profile_json) {
      try {
        const pj = JSON.parse(r.profile_json);
        if (typeof pj.iimb_alignment_score === "number") score = pj.iimb_alignment_score;
      } catch {
        // ignore
      }
    }

    return {
      id: r.id,
      source: r.source,
      season: r.season,
      episode_title: r.episode_title,
      guest_name: r.guest_name,
      organisation: r.organisation,
      status: r.status,
      iimb_alignment_score: score,
      thumbnail_url: r.thumbnail_url,
      published_date: r.published_date
    };
  });
}

function getEpisode(db, id) {
  return db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) || null;
}

function updateEpisode(db, id, patch) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const sets = fields.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE episodes SET ${sets} WHERE id = @id`).run({ id, ...patch });
}

function deleteEpisode(db, id) {
  const row = db.prepare("SELECT id, source FROM episodes WHERE id = ?").get(id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.source !== "manual") return { ok: false, reason: "not_manual" };

  db.prepare("DELETE FROM pipeline_events WHERE episode_id = ?").run(id);
  db.prepare("DELETE FROM episodes WHERE id = ?").run(id);
  return { ok: true };
}

module.exports = { upsertEpisode, listEpisodes, getEpisode, updateEpisode, deleteEpisode };

