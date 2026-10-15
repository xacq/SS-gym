(function initExerciseSqlExport(global) {
  'use strict';

  const DB_SQL = Object.freeze({
    mssql: `CREATE TABLE exercises (
  id                NVARCHAR(10)  PRIMARY KEY,
  name              NVARCHAR(255) NOT NULL,
  category          NVARCHAR(100),
  body_part         NVARCHAR(100),
  equipment         NVARCHAR(100),
  instructions_en   NVARCHAR(MAX),
  instructions_es   NVARCHAR(MAX),
  instructions_it   NVARCHAR(MAX),
  instructions_tr   NVARCHAR(MAX),
  instructions_ru   NVARCHAR(MAX),
  instructions_zh   NVARCHAR(MAX),
  instructions_hi   NVARCHAR(MAX),
  instructions_pl   NVARCHAR(MAX),
  instructions_ko   NVARCHAR(MAX),
  instructions_fr   NVARCHAR(MAX),
  instruction_steps NVARCHAR(MAX),  -- JSON object keyed by language
  muscle_group      NVARCHAR(100),
  secondary_muscles NVARCHAR(MAX),  -- JSON array stored as string
  target            NVARCHAR(100),
  media_id          NVARCHAR(100),
  image             NVARCHAR(500),
  gif_url           NVARCHAR(500),
  attribution       NVARCHAR(500),
  created_at        DATETIMEOFFSET(6)
);`,
    postgresql: `CREATE TABLE exercises (
  id                VARCHAR(10)  PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  category          VARCHAR(100),
  body_part         VARCHAR(100),
  equipment         VARCHAR(100),
  instructions_en   TEXT,
  instructions_es   TEXT,
  instructions_it   TEXT,
  instructions_tr   TEXT,
  instructions_ru   TEXT,
  instructions_zh   TEXT,
  instructions_hi   TEXT,
  instructions_pl   TEXT,
  instructions_ko   TEXT,
  instructions_fr   TEXT,
  instruction_steps JSONB,
  muscle_group      VARCHAR(100),
  secondary_muscles JSONB,
  target            VARCHAR(100),
  media_id          VARCHAR(100),
  image             VARCHAR(500),
  gif_url           VARCHAR(500),
  attribution       VARCHAR(500),
  created_at        TIMESTAMPTZ
);`,
    mysql: `CREATE TABLE exercises (
  id                VARCHAR(10)  PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  category          VARCHAR(100),
  body_part         VARCHAR(100),
  equipment         VARCHAR(100),
  instructions_en   TEXT,
  instructions_es   TEXT,
  instructions_it   TEXT,
  instructions_tr   TEXT,
  instructions_ru   TEXT,
  instructions_zh   TEXT,
  instructions_hi   TEXT,
  instructions_pl   TEXT,
  instructions_ko   TEXT,
  instructions_fr   TEXT,
  instruction_steps JSON,
  muscle_group      VARCHAR(100),
  secondary_muscles JSON,
  target            VARCHAR(100),
  media_id          VARCHAR(100),
  image             VARCHAR(500),
  gif_url           VARCHAR(500),
  attribution       VARCHAR(500),
  created_at        DATETIME(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
    sqlite: `CREATE TABLE exercises (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  category          TEXT,
  body_part         TEXT,
  equipment         TEXT,
  instructions_en   TEXT,
  instructions_es   TEXT,
  instructions_it   TEXT,
  instructions_tr   TEXT,
  instructions_ru   TEXT,
  instructions_zh   TEXT,
  instructions_hi   TEXT,
  instructions_pl   TEXT,
  instructions_ko   TEXT,
  instructions_fr   TEXT,
  instruction_steps TEXT,  -- JSON object keyed by language
  muscle_group      TEXT,
  secondary_muscles TEXT,  -- JSON array stored as string
  target            TEXT,
  media_id          TEXT,
  image             TEXT,
  gif_url           TEXT,
  attribution       TEXT,
  created_at        TEXT
);`,
  });

  function escapeString(value, database) {
    if (value === null || value === undefined) return 'NULL';
    const raw = String(value);
    const escaped = (database === 'mysql' ? raw.replace(/\\/g, '\\\\') : raw)
      .replace(/'/g, "''");
    return database === 'mssql' ? `N'${escaped}'` : `'${escaped}'`;
  }

  function sqlDate(value, database) {
    if (value === null || value === undefined) return 'NULL';
    const normalized = database === 'mysql'
      ? String(value).replace('T', ' ').replace(/(Z|[+-]\d{2}:\d{2})$/, '')
      : value;
    return escapeString(normalized, database);
  }

  function buildInserts(exercises, database) {
    if (!Object.hasOwn(DB_SQL, database)) {
      throw new Error(`Unsupported database: ${database}`);
    }

    const lines = [];
    const header = database === 'mssql' ? 'BEGIN TRANSACTION;\nGO\n' : 'BEGIN;\n';
    const footer = database === 'mssql' ? '\nCOMMIT;\nGO' : '\nCOMMIT;';
    lines.push(header);

    exercises.forEach((exercise, index) => {
      const instructions = exercise.instructions || {};
      const muscles = JSON.stringify(
        Array.isArray(exercise.secondary_muscles) ? exercise.secondary_muscles : [],
      );
      const instructionSteps = JSON.stringify(exercise.instruction_steps || {});
      const instructionEn = instructions.en
        || (Array.isArray(exercise.instruction_steps)
          ? exercise.instruction_steps.join(' ')
          : (exercise.instructions || ''));

      const values = [
        escapeString(exercise.id, database),
        escapeString(exercise.name, database),
        escapeString(exercise.category, database),
        escapeString(exercise.body_part, database),
        escapeString(exercise.equipment, database),
        escapeString(instructionEn, database),
        escapeString(instructions.es || '', database),
        escapeString(instructions.it || '', database),
        escapeString(instructions.tr || '', database),
        escapeString(instructions.ru || '', database),
        escapeString(instructions.zh || '', database),
        escapeString(instructions.hi || '', database),
        escapeString(instructions.pl || '', database),
        escapeString(instructions.ko || '', database),
        escapeString(instructions.fr || '', database),
        escapeString(instructionSteps, database),
        escapeString(exercise.muscle_group, database),
        escapeString(muscles, database),
        escapeString(exercise.target, database),
        escapeString(exercise.media_id, database),
        escapeString(exercise.image, database),
        escapeString(exercise.gif_url, database),
        escapeString(exercise.attribution, database),
        sqlDate(exercise.created_at, database),
      ].join(', ');

      lines.push(`INSERT INTO exercises (id, name, category, body_part, equipment, instructions_en, instructions_es, instructions_it, instructions_tr, instructions_ru, instructions_zh, instructions_hi, instructions_pl, instructions_ko, instructions_fr, instruction_steps, muscle_group, secondary_muscles, target, media_id, image, gif_url, attribution, created_at) VALUES (${values});`);

      if (database === 'mssql' && (index + 1) % 50 === 0 && index + 1 < exercises.length) {
        lines.push('GO');
      }
    });

    lines.push(footer);
    return lines.join('\n');
  }

  global.ExerciseSqlExport = Object.freeze({ DB_SQL, buildInserts });
}(window));
