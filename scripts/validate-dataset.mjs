import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script, runInNewContext } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = path.join(root, 'data', 'exercises.json');
const schemaPath = path.join(root, 'data', 'exercises.schema.json');

const errors = [];
const warnings = [];

function addIssue(collection, location, message) {
  collection.push(`${location}: ${message}`);
}

function resolveRef(schemaRoot, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported schema reference: ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, key) => value[key], schemaRoot);
}

function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function validateSchema(value, node, location, schemaRoot) {
  if (node.$ref) {
    validateSchema(value, resolveRef(schemaRoot, node.$ref), location, schemaRoot);
    return;
  }

  if (node.type && !matchesType(value, node.type)) {
    addIssue(errors, location, `expected ${node.type}`);
    return;
  }

  if (node.enum && !node.enum.includes(value)) {
    addIssue(errors, location, `must be one of: ${node.enum.join(', ')}`);
  }

  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) {
      addIssue(errors, location, `must contain at least ${node.minLength} character(s)`);
    }
    if (node.pattern && !(new RegExp(node.pattern).test(value))) {
      addIssue(errors, location, `does not match ${node.pattern}`);
    }
    if (node.format === 'date-time' && (Number.isNaN(Date.parse(value)) || !value.includes('T'))) {
      addIssue(errors, location, 'must be a valid ISO 8601 date-time');
    }
  }

  if (Array.isArray(value) && node.items) {
    value.forEach((item, index) => validateSchema(item, node.items, `${location}[${index}]`, schemaRoot));
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(value, key)) addIssue(errors, location, `missing required property "${key}"`);
    }

    for (const [key, child] of Object.entries(value)) {
      if (node.properties?.[key]) {
        validateSchema(child, node.properties[key], `${location}.${key}`, schemaRoot);
      } else if (node.additionalProperties === false) {
        addIssue(errors, location, `unexpected property "${key}"`);
      } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
        validateSchema(child, node.additionalProperties, `${location}.${key}`, schemaRoot);
      }
    }
  }
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

async function validateMedia(exercises, field, directory, extension) {
  const referenced = new Set();

  for (const exercise of exercises) {
    const relativePath = exercise[field];
    if (typeof relativePath !== 'string') continue;

    const expected = `${directory}/${exercise.id}-${exercise.media_id}.${extension}`;
    if (relativePath.replaceAll('\\', '/') !== expected) {
      addIssue(errors, `exercise ${exercise.id}.${field}`, `expected "${expected}"`);
    }

    const absolutePath = path.resolve(root, relativePath);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) {
      addIssue(errors, `exercise ${exercise.id}.${field}`, 'path escapes the repository');
      continue;
    }

    referenced.add(path.basename(absolutePath));
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) addIssue(errors, `exercise ${exercise.id}.${field}`, 'does not reference a file');
      if (info.size === 0) addIssue(errors, `exercise ${exercise.id}.${field}`, 'references an empty file');
    } catch {
      addIssue(errors, `exercise ${exercise.id}.${field}`, `missing file "${relativePath}"`);
    }
  }

  const files = (await readdir(path.join(root, directory), { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name);

  for (const file of files) {
    if (!referenced.has(file)) addIssue(errors, directory, `unreferenced file "${file}"`);
  }
}

async function validateInlineScripts(file) {
  const html = await readFile(path.join(root, file), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];

  if (scripts.length === 0) {
    addIssue(errors, file, 'contains no inline scripts to validate');
    return;
  }

  scripts.forEach((match, index) => {
    try {
      new Script(match[1], { filename: `${file}#script-${index + 1}` });
    } catch (error) {
      addIssue(errors, file, `inline script ${index + 1} has invalid JavaScript: ${error.message}`);
    }
  });
}

async function validateJavaScriptFile(file) {
  try {
    const source = await readFile(path.join(root, file), 'utf8');
    new Script(source, { filename: file });
  } catch (error) {
    addIssue(errors, file, `has invalid JavaScript: ${error.message}`);
  }
}

async function validateI18n(exercises) {
  const file = 'scripts/i18n.js';
  try {
    const source = await readFile(path.join(root, file), 'utf8');
    const sandbox = { window: {} };
    runInNewContext(source, sandbox, { filename: file });
    const i18n = sandbox.window.ExerciseI18n;
    const expectedLanguages = ['en', 'es', 'fr', 'pt', 'it', 'de'];
    const baseKeys = Object.keys(i18n?.translations?.en ?? {});
    const html = await readFile(path.join(root, 'index.html'), 'utf8');
    const setupHtml = await readFile(path.join(root, 'setup.html'), 'utf8');
    const referencedKeys = [...html.matchAll(/data-i18n(?:-html|-placeholder)?="([^"]+)"/g)]
      .map(match => match[1]);
    const unknownKeys = [...new Set(referencedKeys)].filter(key => !baseKeys.includes(key));
    if (unknownKeys.length) {
      addIssue(errors, 'index.html', `references unknown translation keys: ${unknownKeys.join(', ')}`);
    }
    const setupBaseKeys = Object.keys(i18n?.setupTranslations?.en ?? {});
    const referencedSetupKeys = [...setupHtml.matchAll(/data-setup-i18n(?:-html)?="([^"]+)"/g)]
      .map(match => match[1]);
    const unknownSetupKeys = [...new Set(referencedSetupKeys)].filter(key => !setupBaseKeys.includes(key));
    if (unknownSetupKeys.length) {
      addIssue(errors, 'setup.html', `references unknown setup translation keys: ${unknownSetupKeys.join(', ')}`);
    }
    const referencedUiKeys = [...setupHtml.matchAll(/data-ui-i18n="([^"]+)"/g)].map(match => match[1]);
    const unknownUiKeys = [...new Set(referencedUiKeys)].filter(key => !baseKeys.includes(key));
    if (unknownUiKeys.length) {
      addIssue(errors, 'setup.html', `references unknown UI translation keys: ${unknownUiKeys.join(', ')}`);
    }
    const taxonomyValues = new Set(exercises.flatMap(exercise => [
      exercise.category,
      exercise.equipment,
      exercise.target,
      exercise.muscle_group,
      ...(exercise.secondary_muscles ?? []),
    ]).filter(Boolean).map(value => value.toLowerCase()));

    for (const language of expectedLanguages) {
      if (!i18n?.languages?.[language]) {
        addIssue(errors, file, `missing language declaration for "${language}"`);
        continue;
      }
      const dictionary = i18n.translations?.[language];
      if (!dictionary) {
        addIssue(errors, file, `missing UI translations for "${language}"`);
        continue;
      }
      const missingKeys = baseKeys.filter(key => !Object.hasOwn(dictionary, key));
      if (missingKeys.length) {
        addIssue(errors, file, `${language} is missing UI keys: ${missingKeys.join(', ')}`);
      }
      const setupDictionary = i18n.setupTranslations?.[language] ?? {};
      const missingSetupKeys = setupBaseKeys.filter(key => !Object.hasOwn(setupDictionary, key));
      if (missingSetupKeys.length) {
        addIssue(errors, file, `${language} is missing setup UI keys: ${missingSetupKeys.join(', ')}`);
      }
      if (language !== 'en') {
        const translatedTaxonomy = i18n.taxonomy?.[language] ?? {};
        const missingTerms = [...taxonomyValues].filter(value => !Object.hasOwn(translatedTaxonomy, value));
        if (missingTerms.length) {
          addIssue(errors, file, `${language} is missing taxonomy terms: ${missingTerms.join(', ')}`);
        }
      }
    }
  } catch (error) {
    addIssue(errors, file, `could not validate translations: ${error.message}`);
  }
}

async function validateHtmlStructure(file) {
  const html = await readFile(path.join(root, file), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);

  for (const duplicate of findDuplicates(ids)) {
    addIssue(errors, file, `duplicate HTML id "${duplicate}"`);
  }

  const knownIds = new Set(ids);
  const domReferences = [...html.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
  for (const reference of new Set(domReferences)) {
    if (!knownIds.has(reference)) addIssue(errors, file, `getElementById references missing id "${reference}"`);
  }

  const scriptSources = [...html.matchAll(/<script\s[^>]*src="([^"]+)"[^>]*><\/script>/gi)]
    .map(match => match[1]);
  for (const source of scriptSources) {
    const scriptPath = path.resolve(root, source);
    if (!scriptPath.startsWith(`${root}${path.sep}`)) {
      addIssue(errors, file, `script source escapes the repository: "${source}"`);
      continue;
    }
    try {
      const info = await stat(scriptPath);
      if (!info.isFile()) addIssue(errors, file, `script source is not a file: "${source}"`);
    } catch {
      addIssue(errors, file, `references missing script "${source}"`);
    }
  }
}

async function validateSqlExporter(exercises) {
  const file = 'scripts/sql-export.js';
  const source = await readFile(path.join(root, file), 'utf8');
  const match = source.match(/INSERT INTO exercises \(([^)]*)\) VALUES \(\$\{values\}\)/);
  const expectedColumns = [
    'id', 'name', 'category', 'body_part', 'equipment',
    'instructions_en', 'instructions_es', 'instructions_it', 'instructions_tr',
    'instructions_ru', 'instructions_zh', 'instructions_hi', 'instructions_pl',
    'instructions_ko', 'instructions_fr', 'instruction_steps', 'muscle_group',
    'secondary_muscles', 'target', 'media_id', 'image', 'gif_url', 'attribution',
    'created_at',
  ];

  if (!match) {
    addIssue(errors, file, 'SQL exporter INSERT statement was not found');
    return;
  }

  const actualColumns = match[1].split(',').map(column => column.trim());
  if (actualColumns.join(',') !== expectedColumns.join(',')) {
    addIssue(errors, file, 'SQL exporter columns are incomplete or out of order');
  }

  const valuesBlock = source.match(/const values = \[([\s\S]*?)\]\.join\(', '\);/);
  if (!valuesBlock) {
    addIssue(errors, file, 'SQL exporter values list was not found');
    return;
  }

  const valueCount = [...valuesBlock[1].matchAll(/(?:escapeString|sqlDate)\(/g)].length;
  if (valueCount !== expectedColumns.length) {
    addIssue(errors, file, `SQL exporter has ${expectedColumns.length} columns but ${valueCount} values`);
  }

  try {
    const sandbox = { window: {} };
    runInNewContext(source, sandbox, { filename: file });
    const exporter = sandbox.window.ExerciseSqlExport;
    const databases = ['mssql', 'postgresql', 'mysql', 'sqlite'];
    for (const database of databases) {
      if (!exporter?.DB_SQL?.[database]) {
        addIssue(errors, file, `missing CREATE TABLE template for ${database}`);
        continue;
      }
      const sql = exporter.buildInserts([exercises[0]], database);
      if (!sql.includes('INSERT INTO exercises')) {
        addIssue(errors, file, `${database} export did not produce an INSERT statement`);
      }
      if (sql.includes('undefined')) {
        addIssue(errors, file, `${database} export contains an undefined value`);
      }
    }
  } catch (error) {
    addIssue(errors, file, `could not execute SQL exporter: ${error.message}`);
  }
}

async function main() {
  const [datasetText, schemaText] = await Promise.all([
    readFile(dataPath, 'utf8'),
    readFile(schemaPath, 'utf8'),
  ]);

  const exercises = JSON.parse(datasetText);
  const schema = JSON.parse(schemaText);
  validateSchema(exercises, schema, '$', schema);

  for (const field of ['id', 'media_id']) {
    for (const duplicate of findDuplicates(exercises.map(exercise => exercise[field]))) {
      addIssue(errors, field, `duplicate value "${duplicate}"`);
    }
  }

  for (const exercise of exercises) {
    if (exercise.category !== exercise.body_part) {
      addIssue(errors, `exercise ${exercise.id}`, 'category and body_part must match');
    }
  }

  await Promise.all([
    validateMedia(exercises, 'image', 'images', 'jpg'),
    validateMedia(exercises, 'gif_url', 'videos', 'gif'),
    validateInlineScripts('index.html'),
    validateInlineScripts('setup.html'),
    validateJavaScriptFile('data/exercises.js'),
    validateJavaScriptFile('scripts/i18n.js'),
    validateJavaScriptFile('scripts/sql-export.js'),
    validateI18n(exercises),
    validateHtmlStructure('index.html'),
    validateHtmlStructure('setup.html'),
    validateSqlExporter(exercises),
  ]);

  const duplicateNames = findDuplicates(exercises.map(exercise => exercise.name));
  if (duplicateNames.length) {
    addIssue(warnings, 'name', `${duplicateNames.length} duplicate name(s): ${duplicateNames.join(', ')}`);
  }

  const languages = Object.keys(schema.$defs.languageMap.properties);
  let instructionMismatches = 0;
  const affectedExercises = new Set();
  for (const exercise of exercises) {
    for (const language of languages) {
      if (exercise.instructions?.[language] !== exercise.instruction_steps?.[language]?.join(' ')) {
        instructionMismatches += 1;
        affectedExercises.add(exercise.id);
      }
    }
  }
  if (instructionMismatches) {
    addIssue(
      warnings,
      'instructions',
      `${instructionMismatches} full-text/step mismatch(es) across ${affectedExercises.size} exercise(s)`,
    );
  }

  console.log(`Validated ${exercises.length} exercises and their media.`);
  warnings.forEach(warning => console.warn(`WARNING ${warning}`));

  if (errors.length) {
    errors.forEach(error => console.error(`ERROR ${error}`));
    console.error(`Validation failed with ${errors.length} error(s).`);
    process.exitCode = 1;
    return;
  }

  console.log(`Validation passed with ${warnings.length} warning(s).`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
