/**
 * Uplevyl Dashboard — Weekly Data Collector
 *
 * Pulls metrics from:
 *   1. GA4 Data API  (website traffic)
 *   2. GoHighLevel   (email campaigns) — placeholder until API key is added
 *   3. LinkedIn       (company page)   — placeholder until token is added
 *
 * Then patches index.html's LIVE_DATA and WEEKLY arrays and writes the file.
 */

import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID || '291261478';
const GA4_KEY_FILE    = process.env.GA4_KEY_FILE    || '/tmp/ga4-key.json';
const GHL_API_KEY     = process.env.GHL_API_KEY     || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || '';
const LI_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN || '';
const LI_ORG_ID       = process.env.LINKEDIN_ORG_ID || '';

const INDEX_PATH = path.resolve(process.cwd(), 'index.html');

function getWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const diffToLastMon = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diffToLastMon - 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: fmt(monday), end: fmt(sunday), label: `${shortDate(monday)}–${shortDate(sunday)}` };
}

function fmt(d) { return d.toISOString().slice(0, 10); }

function shortDate(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

async function fetchGA4(startDate, endDate) {
  if (!fs.existsSync(GA4_KEY_FILE)) { console.warn('GA4 key file not found'); return null; }

  const auth = new google.auth.GoogleAuth({
    keyFile: GA4_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });

  const { data: main } = await analyticsData.properties.runReport({
    property: `properties/${GA4_PROPERTY_ID}`,
    requestBody: {
      dateRanges: [{ startDate, endDate }],
      metrics: [
        { name: 'activeUsers' }, { name: 'newUsers' }, { name: 'sessions' },
        { name: 'engagedSessions' }, { name: 'engagementRate' },
        { name: 'screenPageViews' }, { name: 'averageSessionDuration' },
      ],
    },
  });

  const row = main.rows?.[0]?.metricValues || [];
  const activeUsers = Number(row[0]?.value || 0);
  const newUsers = Number(row[1]?.value || 0);
  const sessions = Number(row[2]?.value || 0);
  const engagedSessions = Number(row[3]?.value || 0);
  const engagementRate = Number((Number(row[4]?.value || 0) * 100).toFixed(2));
  const pageViews = Number(row[5]?.value || 0);
  const avgEngSec = Number(row[6]?.value || 0);
  const avgEngagement = avgEngSec < 60 ? `${Math.round(avgEngSec)}s` : `${Math.floor(avgEngSec/60)}m ${Math.round(avgEngSec%60)}s`;

  const { data: channels } = await analyticsData.properties.runReport({
    property: `properties/${GA4_PROPERTY_ID}`,
    requestBody: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
    },
  });
  const channelMap = { Direct: 0, Referral: 0, Organic: 0 };
  for (const r of channels.rows || []) {
    const ch = r.dimensionValues[0].value;
    const val = Number(r.metricValues[0].value);
    if (ch === 'Direct') channelMap.Direct = val;
    else if (ch === 'Referral') channelMap.Referral = val;
    else if (ch.includes('Organic')) channelMap.Organic += val;
  }

  const { data: pages } = await analyticsData.properties.runReport({
    property: `properties/${GA4_PROPERTY_ID}`,
    requestBody: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pageTitle' }],
      metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 5,
    },
  });
  const topPages = (pages.rows || []).map(r => ({
    page: r.dimensionValues[0].value, views: Number(r.metricValues[0].value),
  }));

  return { activeUsers, newUsers, returningUsers: activeUsers - newUsers, sessions, engagedSessions, engagementRate, pageViews, avgEngagement, channels: channelMap, topPages };
}

async function fetchGHL() {
  if (!GHL_API_KEY) { console.warn('GHL_API_KEY not set'); return null; }
  try {
    const resp = await fetch(`https://services.leadconnectorhq.com/campaigns/?locationId=${GHL_LOCATION_ID}`, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' },
    });
    if (!resp.ok) { console.warn(`GHL API returned ${resp.status}`); return null; }
    const data = await resp.json();
    let totalSent = 0, totalOpens = 0, totalClicks = 0, totalUnsubs = 0;
    for (const c of (data.campaigns || []).slice(0, 10)) {
      totalSent += c.statistics?.sent || 0;
      totalOpens += c.statistics?.opened || 0;
      totalClicks += c.statistics?.clicked || 0;
      totalUnsubs += c.statistics?.unsubscribed || 0;
    }
    const openRate = totalSent > 0 ? Number(((totalOpens / totalSent) * 100).toFixed(1)) : 0;
    return { audience: totalSent, opens: totalOpens, openRate, clicks: totalClicks, unsubs: totalUnsubs };
  } catch (err) { console.warn('GHL fetch failed:', err.message); return null; }
}

async function fetchLinkedIn() {
  if (!LI_ACCESS_TOKEN) { console.warn('LINKEDIN_ACCESS_TOKEN not set'); return null; }
  try {
    const statsResp = await fetch(`https://api.linkedin.com/v2/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=urn:li:organization:${LI_ORG_ID}`,
      { headers: { 'Authorization': `Bearer ${LI_ACCESS_TOKEN}` } });
    if (!statsResp.ok) { console.warn(`LinkedIn API returned ${statsResp.status}`); return null; }
    const statsData = await statsResp.json();
    const followers = statsData.elements?.[0]?.followerCounts?.organicFollowerCount || 0;
    const pageResp = await fetch(`https://api.linkedin.com/v2/organizationPageStatistics?q=organization&organization=urn:li:organization:${LI_ORG_ID}`,
      { headers: { 'Authorization': `Bearer ${LI_ACCESS_TOKEN}` } });
    let pageViews = 0, uniqueVisitors = 0;
    if (pageResp.ok) {
      const pageData = await pageResp.json();
      pageViews = pageData.elements?.[0]?.views?.allPageViews?.pageViews || 0;
      uniqueVisitors = pageData.elements?.[0]?.views?.allPageViews?.uniquePageViews || 0;
    }
    return { followers, newFollowers: 0, newsletterSubs: 0, newSubs: 0, pageViews, uniqueVisitors, impressions: 0, reactions: 0, comments: 0, reposts: 0, articleViews: 0, engagements: 0 };
  } catch (err) { console.warn('LinkedIn fetch failed:', err.message); return null; }
}

function patchIndexHtml(ga4, ghl, linkedin, weekLabel) {
  let html = fs.readFileSync(INDEX_PATH, 'utf-8');
  const today = new Date();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const updatedStr = `${months[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;

  const existingMatch = html.match(/const LIVE_DATA = (\{[\s\S]*?\});/);
  let existingLiveData = {};
  if (existingMatch) { try { existingLiveData = new Function(`return ${existingMatch[1]}`)(); } catch (e) {} }

  const newLiveData = {
    lastUpdated: updatedStr, currentWeek: weekLabel,
    website: ga4 ? { activeUsers: ga4.activeUsers, newUsers: ga4.newUsers, returningUsers: ga4.returningUsers, sessions: ga4.sessions, engagedSessions: ga4.engagedSessions, engagementRate: ga4.engagementRate, pageViews: ga4.pageViews, avgEngagement: ga4.avgEngagement, channels: ga4.channels, topPages: ga4.topPages } : existingLiveData.website,
    linkedin: linkedin ? { followers: linkedin.followers, newFollowers: linkedin.newFollowers, newsletterSubs: linkedin.newsletterSubs, newSubs: linkedin.newSubs, pageViews: linkedin.pageViews, uniqueVisitors: linkedin.uniqueVisitors, impressions: linkedin.impressions, reactions: linkedin.reactions, comments: linkedin.comments, reposts: linkedin.reposts, articleViews: linkedin.articleViews, engagements: linkedin.engagements } : existingLiveData.linkedin,
  };

  const weekEntry = {
    week: weekLabel,
    w: ga4 ? { au: ga4.activeUsers, nu: ga4.newUsers, ret: ga4.returningUsers, sess: ga4.sessions, eng: ga4.engagedSessions, pv: ga4.pageViews, dir: ga4.channels?.Direct || 0, org: ga4.channels?.Organic || 0, ref: ga4.channels?.Referral || 0 } : null,
    l: linkedin ? { fol: linkedin.followers, nf: linkedin.newFollowers, sub: linkedin.newsletterSubs, ns: linkedin.newSubs, imp: linkedin.impressions, rx: linkedin.reactions, av: linkedin.articleViews } : null,
    e: ghl ? { aud: ghl.audience, opens: ghl.opens, or: ghl.openRate, clicks: ghl.clicks, unsubs: ghl.unsubs } : null,
  };

  const liveDataStr = `const LIVE_DATA = ${JSON.stringify(newLiveData, null, 2)};`;
  html = html.replace(/\/\/ ─── LIVE DATA.*?\nconst LIVE_DATA = \{[\s\S]*?\};/, `// ─── LIVE DATA (collected ${updatedStr}) ────────────────────────────────────\n${liveDataStr}`);

  const weeklyMatch = html.match(/const WEEKLY = (\[[\s\S]*?\]);/);
  if (weeklyMatch) {
    try {
      const existingWeekly = new Function(`return ${weeklyMatch[1]}`)();
      const filtered = existingWeekly.filter(w => w.week !== weekLabel);
      filtered.push(weekEntry);
      const trimmed = filtered.slice(-16);
      const weeklyStr = `const WEEKLY = ${JSON.stringify(trimmed, null, 2)};`;
      html = html.replace(/\/\/ ─── HISTORICAL.*?\nconst WEEKLY = \[[\s\S]*?\];/, `// ─── HISTORICAL (auto-collected weekly data) ──────────────────────\n${weeklyStr}`);
    } catch (e) { console.error('Failed to parse WEEKLY:', e.message); }
  }

  fs.writeFileSync(INDEX_PATH, html);
  console.log(`index.html updated — week: ${weekLabel}, updated: ${updatedStr}`);
}

async function main() {
  const { start, end, label } = getWeekRange();
  console.log(`Collecting data for week: ${label} (${start} to ${end})`);
  const [ga4, ghl, linkedin] = await Promise.all([fetchGA4(start, end), fetchGHL(), fetchLinkedIn()]);
  if (ga4) console.log('GA4 data collected');
  if (ghl) console.log('GoHighLevel data collected');
  if (linkedin) console.log('LinkedIn data collected');
  if (!ga4 && !ghl && !linkedin) { console.error('No data sources returned data. Aborting.'); process.exit(1); }
  patchIndexHtml(ga4, ghl, linkedin, label);
}

main().catch(err => { console.error('Pipeline failed:', err); process.exit(1); });
