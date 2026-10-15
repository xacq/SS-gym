import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(root, 'index.html');
const datasetPath = path.join(root, 'data', 'exercises.json');
const browserDataPath = path.join(root, 'data', 'exercises.js');
const checkOnly = process.argv.includes('--check');

function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

async function main() {
  const [html, datasetText, currentBrowserData] = await Promise.all([
    readFile(indexPath, 'utf8'),
    readFile(datasetPath, 'utf8'),
    readFile(browserDataPath, 'utf8').catch(() => ''),
  ]);
  const exercises = JSON.parse(datasetText);
  const serialized = serializeForInlineScript(exercises);
  const generatedBrowserData = `window.EXERCISES_DATA = ${serialized};\n`;
  const embeddedPattern = /(^[ \t]*const EXERCISES = )[\s\S]*?(;\r?\n\r?\n[ \t]*\/\/ ── State)/m;
  const hasExternalReference = html.includes('const EXERCISES = window.EXERCISES_DATA;');
  const synchronized = currentBrowserData === generatedBrowserData && hasExternalReference;

  if (synchronized) {
    console.log(`Browser data is synchronized with ${exercises.length} exercises.`);
    return;
  }

  if (checkOnly) {
    console.error('Browser data is out of date. Run: node scripts/build-index.mjs');
    process.exitCode = 1;
    return;
  }

  await writeFile(browserDataPath, generatedBrowserData, 'utf8');

  if (!hasExternalReference) {
    if (!embeddedPattern.test(html)) throw new Error('Could not find the EXERCISES source in index.html');
    const migratedHtml = html.replace(
      embeddedPattern,
      (_, prefix, suffix) => `${prefix}window.EXERCISES_DATA${suffix}`,
    );
    await writeFile(indexPath, migratedHtml, 'utf8');
  }

  console.log(`Generated browser data for ${exercises.length} exercises.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
