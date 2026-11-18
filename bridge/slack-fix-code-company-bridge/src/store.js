import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function decode(row) {
  return row ? JSON.parse(row.data) : null;
}

function json(value) {
  return JSON.stringify(value);
}

function outboxEntries(entries) {
  if (entries == null) return [];
  return Array.isArray(entries) ? entries : [entries];
}

/** Durable, synchronous storage for bridge tasks, jobs, events, and replies. */
export class Store {
  constructor(path) {
    if (!path) throw new TypeError('A SQLite database path is required');
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS instance (id INTEGER PRIMARY KEY CHECK(id = 1), data JSON NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data JSON NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL,
        data JSON NOT NULL, created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs(created, id);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, data JSON NOT NULL,
        created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_created_idx ON outbox(created, id);
    `);
    if (path !== ':memory:') {
      try { chmodSync(path, 0o600); } catch { /* The database may be URI-backed. */ }
    }
  }

  getInstance() { return decode(this.db.prepare('SELECT data FROM instance WHERE id = 1').get()); }

  claimInstance(record, isAlive) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.getInstance();
      if (previous && isAlive(previous)) throw new Error('Another bridge is already running for this state directory.');
      this.db.prepare('INSERT INTO instance(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(json(record));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  releaseInstance(token) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.getInstance()?.token === token) this.db.prepare('DELETE FROM instance WHERE id = 1').run();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getTask(id) {
    return decode(this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id));
  }

  saveTask(task) {
    if (!task || task.id == null) throw new TypeError('Task must have an id');
    this.db.prepare(`INSERT INTO tasks(id, data) VALUES(?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(String(task.id), json(task));
    return task;
  }

  getJob(id) {
    if (id == null) return null;
    return decode(this.db.prepare('SELECT data FROM jobs WHERE id = ?').get(id));
  }

  saveJob(job) {
    if (!job || job.id == null || job.taskId == null) throw new TypeError('Job must have id and taskId');
    const created = Number.isFinite(job.created) ? job.created : Date.now();
    const data = Number.isFinite(job.created) ? job : { ...job, created };
    this.db.prepare(`INSERT INTO jobs(id, task_id, status, data, created) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, status = excluded.status,
      data = excluded.data, created = excluded.created`).run(
      String(job.id), String(job.taskId), String(job.status ?? 'queued'), json(data), created,
    );
    return data;
  }

  jobsForTask(taskId) {
    return this.db.prepare('SELECT data FROM jobs WHERE task_id = ? ORDER BY created ASC, rowid ASC')
      .all(String(taskId)).map(decode);
  }

  nextJob() {
    return decode(this.db.prepare("SELECT data FROM jobs WHERE status = 'queued' ORDER BY created ASC, rowid ASC LIMIT 1").get());
  }

  listJobs(status) {
    const rows = status === undefined
      ? this.db.prepare('SELECT data FROM jobs ORDER BY created ASC, rowid ASC').all()
      : this.db.prepare('SELECT data FROM jobs WHERE status = ? ORDER BY created ASC, rowid ASC').all(status);
    return rows.map(decode);
  }

  listTasks() {
    return this.db.prepare('SELECT data FROM tasks ORDER BY rowid ASC').all().map(decode);
  }

  pendingOutbox(now = Date.now()) {
    return this.db.prepare("SELECT data FROM outbox WHERE status = 'pending' ORDER BY created ASC, rowid ASC")
      .all().map(decode).filter((entry) => Number(entry.nextAttemptAt ?? 0) <= now);
  }

  saveOutbox(entry) {
    if (!entry || entry.id == null) throw new TypeError('Outbox entry must have an id');
    const created = Number.isFinite(entry.created) ? entry.created : Date.now();
    const data = Number.isFinite(entry.created) ? entry : { ...entry, created };
    this.db.prepare(`INSERT INTO outbox(id, status, data, created) VALUES(?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data,
      created = excluded.created`).run(String(entry.id), String(entry.status ?? 'pending'), json(data), created);
    return data;
  }

  getOutbox(id) {
    return decode(this.db.prepare('SELECT data FROM outbox WHERE id = ?').get(id));
  }

  listOutbox(status) {
    const rows = status === undefined
      ? this.db.prepare('SELECT data FROM outbox ORDER BY created ASC, rowid ASC').all()
      : this.db.prepare('SELECT data FROM outbox WHERE status = ? ORDER BY created ASC, rowid ASC').all(status);
    return rows.map(decode);
  }

  /** Insert an event and its related records as one deduplicated transaction. */
  accept({ eventId, task, job, jobs = [], outbox } = {}) {
    if (eventId == null) throw new TypeError('eventId is required');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('INSERT OR IGNORE INTO events(id) VALUES(?)').run(String(eventId));
      if (Number(result.changes) === 0) {
        this.db.exec('ROLLBACK');
        return false;
      }
      if (task) this.saveTask(task);
      if (job) this.saveJob(job);
      for (const queued of jobs) this.saveJob(queued);
      for (const entry of outboxEntries(outbox)) this.saveOutbox(entry);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

export default Store;
