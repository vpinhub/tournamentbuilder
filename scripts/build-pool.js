#!/usr/bin/env node
/**
 * Builds data/pool.json — the static pool of tables eligible for
 * "Special When Lit" / "Thursday Throwdown" auto-selection.
 *
 * A table qualifies when at least one of its VPS table-file releases:
 *   - has "nFozzy" in its features list, AND
 *   - has at least one author matching TARGET_AUTHORS (substring, case-insensitive)
 *
 * When a game has multiple qualifying releases, the "best" one is kept
 * (see scoreRelease) so the pool has exactly one entry per table.
 *
 * Usage:
 *   node scripts/build-pool.js                 # fetches vpsdb.json from GitHub
 *   node scripts/build-pool.js path/to/vpsdb.json   # use a local copy instead
 */

const fs = require('fs');
const path = require('path');

const VPSDB_URL = 'https://raw.githubusercontent.com/VirtualPinballSpreadsheet/vps-db/refs/heads/main/db/vpsdb.json';
const OUT_PATH = path.join(__dirname, '..', 'data', 'pool.json');

const TARGET_AUTHORS = [
    'vpinworkshop',
    'vpw',
    'wizball',
    'joepicasso',
    'unclepaulie',
    'bord',
    'scottacus',
    'hauntfreaks',
    'idigstuff',
    'zandysarcade',
    'tastywasps',
    'rothbauerw',
];

function matchesTargetAuthor(author) {
    const lower = author.toLowerCase();
    return TARGET_AUTHORS.some((t) => lower.includes(t));
}

function hasNfozzy(features) {
    return (features || []).some((f) => /nfozzy/i.test(f));
}

function matchedAuthorsOf(authors) {
    return (authors || []).filter(matchesTargetAuthor);
}

// Higher score wins when a game has more than one qualifying release.
function scoreRelease(tf) {
    let score = 0;
    if (!tf.parentId) score += 10; // prefer a root release over a "MOD of X" variant
    if (tf.tableFormat === 'VPX') score += 5;
    score += matchedAuthorsOf(tf.authors).length;
    score += (tf.updatedAt || 0) / 1e15; // tiny tiebreaker toward newer releases
    return score;
}

function pickBestB2sImage(game, tf) {
    const b2sFiles = game.b2sFiles || [];
    if (b2sFiles.length) {
        const withFullDmd = b2sFiles.find((b) => (b.features || []).includes('FullDMD') && b.imgUrl);
        if (withFullDmd) return withFullDmd.imgUrl;
        const withImg = b2sFiles.find((b) => b.imgUrl);
        if (withImg) return withImg.imgUrl;
    }
    return tf.imgUrl || game.imgUrl || null;
}

function pickRomInfo(game) {
    const romFiles = (game.romFiles || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!romFiles.length) return { romId: null, romAuthor: null, romOptions: [] };
    const primary = romFiles[0];
    return {
        romId: primary.version || null,
        romAuthor: (primary.authors || [])[0] || null,
        romOptions: romFiles.slice(0, 5).map((r) => ({
            romId: r.version || null,
            author: (r.authors || [])[0] || null,
        })),
    };
}

function pickTutorials(game) {
    return (game.tutorialFiles || [])
        .map((t) => ({
            title: t.title || (t.authors || [])[0] || 'Tutorial',
            url: t.url || (t.urls && t.urls[0] && t.urls[0].url) || null,
        }))
        .filter((t) => t.url)
        .slice(0, 4);
}

function buildPoolEntry(game, tf) {
    const tableId = game.id;
    const releaseId = tf.id;
    return {
        tableId,
        releaseId,
        name: game.name,
        manufacturer: game.manufacturer || null,
        year: game.year || null,
        theme: game.theme || [],
        mpu: game.MPU || null,
        type: game.type || null,
        authors: tf.authors || [],
        matchedAuthors: matchedAuthorsOf(tf.authors),
        features: tf.features || [],
        b2sImageUrl: pickBestB2sImage(game, tf),
        tableImageUrl: tf.imgUrl || game.imgUrl || null,
        ipdbUrl: game.ipdbUrl || null,
        ...pickRomInfo(game),
        tutorials: pickTutorials(game),
        tournamentHelperUrl: `https://vpinhub.github.io/tournamenthelper/?tableId=${tableId}&releaseId=${releaseId}`,
        iscoredTag: `https://virtualpinballspreadsheet.github.io/?game=${tableId}&fileType=table#${releaseId}`,
    };
}

async function loadVpsdb(sourceArg) {
    if (sourceArg) {
        const raw = fs.readFileSync(sourceArg, 'utf8');
        return JSON.parse(raw);
    }
    console.log(`Fetching ${VPSDB_URL} ...`);
    const res = await fetch(VPSDB_URL);
    if (!res.ok) throw new Error(`Failed to fetch vpsdb.json: ${res.status} ${res.statusText}`);
    return res.json();
}

async function main() {
    const sourceArg = process.argv[2];
    const games = await loadVpsdb(sourceArg);

    const tables = [];

    for (const game of games) {
        let bestQualifying = null;
        let bestOverall = null;

        for (const tf of game.tableFiles || []) {
            const score = scoreRelease(tf);
            if (!bestOverall || score > bestOverall.score) bestOverall = { score, tf };
            if (hasNfozzy(tf.features) && (tf.authors || []).some(matchesTargetAuthor)) {
                if (!bestQualifying || score > bestQualifying.score) bestQualifying = { score, tf };
            }
        }

        // A game with no table files at all can't generate a tournament helper URL — skip it.
        const chosen = bestQualifying || bestOverall;
        if (!chosen) continue;

        const entry = buildPoolEntry(game, chosen.tf);
        entry.inPool = !!bestQualifying; // eligible for auto Random pick
        tables.push(entry);
    }

    tables.sort((a, b) => a.name.localeCompare(b.name));
    const poolCount = tables.filter((t) => t.inPool).length;

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(
        OUT_PATH,
        JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                sourceAuthors: TARGET_AUTHORS,
                count: tables.length,
                poolCount,
                tables,
            },
            null,
            2
        )
    );

    console.log(`Wrote ${tables.length} tables (${poolCount} auto-pick eligible) to ${OUT_PATH}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
