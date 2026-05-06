const { v4: uuidv4 } = require("uuid");

function addPipelineEvent(db, { episode_id, run_id, level, step = null, message = null, data = null }) {
  const id = uuidv4();
  db.prepare(
    `
    INSERT INTO pipeline_events (
      id, episode_id, run_id, level, step, message, data_json
    ) VALUES (
      @id, @episode_id, @run_id, @level, @step, @message, @data_json
    )
  `
  ).run({
    id,
    episode_id,
    run_id,
    level,
    step,
    message,
    data_json: data == null ? null : JSON.stringify(data)
  });
}

function listPipelineEvents(db, { episode_id, limit = 200 }) {
  return db
    .prepare(
      `
      SELECT id, episode_id, run_id, level, step, message, data_json, created_at
      FROM pipeline_events
      WHERE episode_id = ?
      ORDER BY datetime(created_at) DESC
      LIMIT ?
    `
    )
    .all(episode_id, limit);
}

module.exports = { addPipelineEvent, listPipelineEvents };

