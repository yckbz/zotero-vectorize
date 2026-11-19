import { DatabaseSync } from 'node:sqlite';

export class SqliteConnection {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.closed = false;
  }
  async queryAsync(sql, params = []) {
    if (params[0] !== null && typeof params[0] === 'object') throw new Error('Gecko rejects object-like first positional parameters');
    return this.db.prepare(sql).all(...params);
  }
  async rowQueryAsync(sql, params = []) { return this.db.prepare(sql).get(...params); }
  async valueQueryAsync(sql, params = []) {
    return Object.values(await this.rowQueryAsync(sql, params) ?? {})[0];
  }
  async executeTransaction(fn) {
    this.db.exec('BEGIN');
    try {
      await fn();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async closeDatabase() {
    this.db.close();
    this.closed = true;
  }
}
