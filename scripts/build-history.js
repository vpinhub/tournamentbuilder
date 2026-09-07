#!/usr/bin/env node
/**
 * Builds data/history.json — for every table name that has appeared in a
 * past VPINHUB CompetitionCentral tournament, records the most recent
 * occurrence (competition series, event period, and winner).
 *
 * Used by index.html to show a "last played / last winner" note when a
 * table is selected.
 *
 * Usage: node scripts/build-history.js
 */

const fs = require('fs');
const path = require('path');

const LIST_URL = 'https://raw.githubusercontent.com/vpinhub/competitioncentral/refs/heads/main/json/list.json';
const BASE_URL = 'https://raw.githubusercontent.com/vpinhub/competitioncentral/refs/heads/main/';
const OUT_PATH = path.join(__dirname, '..', 'data', 'history.json');

const COMPETITION_LABELS = {
    Special_When_Lit: 'Special When Lit',
    Thursday_Throwdown: 'Thursday Throwdown',
};

function parseDateFromName(name) {
    const m = name.match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res.json();
}

async function main() {
    console.log(`Fetching ${LIST_URL} ...`);
    const list = await fetchJson(LIST_URL);
    console.log(`Found ${list.length} past tournament records, fetching each...`);

    const records = await Promise.all(
        list.map(async (entry) => {
            try {
                const data = await fetchJson(BASE_URL + entry.path);
                const date = parseDateFromName(entry.name) || (data.date_exported || '').slice(0, 10);
                if (!data.table || !date) return null;
                return {
                    table: data.table,
                    competition: data.competition,
                    period: data.period || null,
                    winner: (data.awards && data.awards.winner) || null,
                    date,
                };
            } catch (e) {
                console.warn(`  skip ${entry.path}: ${e.message}`);
                return null;
            }
        })
    );

    const byTable = {};
    for (const rec of records) {
        if (!rec) continue;
        const key = rec.table.trim().toLowerCase();
        const existing = byTable[key];
        if (!existing || rec.date > existing.date) {
            byTable[key] = {
                table: rec.table,
                competition: COMPETITION_LABELS[rec.competition] || rec.competition,
                period: rec.period,
                winner: rec.winner,
                date: rec.date,
            };
        }
    }

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(
        OUT_PATH,
        JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                count: Object.keys(byTable).length,
                byTable,
            },
            null,
            2
        )
    );

    console.log(`Wrote history for ${Object.keys(byTable).length} tables to ${OUT_PATH}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
