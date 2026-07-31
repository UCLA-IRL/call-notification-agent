/**
 * Ownly Headless Utility.
 *
 * This synchronizes an Ownly project to the filesystem.
 * Requires Node.js 23 or later.
 *
 * See .env.example for expected env vars. Create .env with values added
 */

/// <reference types="node" />
/// <reference types="../services.d.ts" />

import fs from 'fs';

import { NodeStatsDb } from '../services/database/stats_node';
import { NodeProjDb } from '../services/database/proj_db_node';

import ndn from '../services/ndn.js';
import { Workspace } from '../services/workspace.js';
import * as utils from '../utils/index.js';
import { Bind9DnsProvider } from './providers/bind9.ts';

import * as nodemailer from 'nodemailer';
import markdown from '@wcj/markdown-to-html';

import express from 'express';
import cors from 'cors';

import 'dotenv/config';

// Verify that .env values are provided
const AGENT_EMAIL = requireEnv('AGENT_EMAIL');
const AGENT_EMAIL_PASSWORD = requireEnv('AGENT_EMAIL_PASSWORD');
const MAIL_TO = requireEnv('MAIL_TO');
const MAIL_BCC = requireEnv('MAIL_BCC');
const DNS_API_URL = requireEnv('DNS_API_URL');
const DNS_API_SECRET = requireEnv('DNS_API_SECRET');
const AGENT_DNS_NAME = requireEnv('AGENT_DNS_NAME');

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

async function main() {
  try {
    await initEnvironment();

    try {
      const { wkspName, psk, channel } = JSON.parse(fs.readFileSync('./wksp.env', 'utf-8'));
      const pskArray = new Uint8Array(Buffer.from(psk, 'hex'));
      console.log('Found workspace details!');
      console.log(wkspName, pskArray, channel);
      startAgent(wkspName, pskArray, channel);
    } catch {
      await startHttpServer();
    }
  } catch (e) {
    console.error('FATAL:', e);
    process.exit(1);
  }
}

async function initEnvironment() {
  await loadServices();
  await loadGoEnvironment();

  await ndn.setup();

  if (!(await ndn.api.has_testbed_key())) {
    console.log('No NDN testbed certificate found. Starting NDNCERT DNS challenge...');

    const dnsProvider = new Bind9DnsProvider(DNS_API_URL, DNS_API_SECRET);
    const agentDns = AGENT_DNS_NAME;
    const recordName = `_ndncert-challenge.${agentDns}`;

    try {
      await ndn.api.ndncert_dns(agentDns, async (_recordName, expectedValue, status) => {
        console.log(`NDNCERT DNS status: ${status}`);
        if (status === 'need-record' || status === 'wrong-record') {
          await dnsProvider.deleteTxt(recordName).catch(() => {});
          await dnsProvider.insertTxt(recordName, expectedValue);
          console.log(`Inserted TXT record: ${recordName} = ${expectedValue}`);
          return 'ready';
        }
        return '';
      });
    } finally {
      await dnsProvider.deleteTxt(recordName).catch(() => {});
      console.log('Cleaned up TXT record');
    }

    console.log('NDNCERT DNS challenge completed!');
  }
}

async function startAgent(wkspName: string, psk: Uint8Array, channelName: string) {
  // Setup the workspace
  const wksp = await setupWorkspace(wkspName, psk);

  console.log(`Joined workspace '${wkspName}'`);
  await new Promise((resolve) => setTimeout(resolve, 20000)); // Wait for sync

  const chat = wksp.chat;

  // Listen for new messages and respond
  chat.events.on('chat', async (msgChannelName) => {
    if (msgChannelName !== channelName) return;

    await new Promise((resolve) => setTimeout(resolve, 20000));

    // Find the agenda.md file
    let fileContents;
    for (const project of wksp.proj.getProjects()) {
      const instance = await wksp.proj.get(project.name);
      const entry = instance.getFileList().find((f) => f.path === '/agenda.md');
      if (entry) {
        fileContents = await instance.getFile(entry.path);
        break;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 20000));
    if (!fileContents) {
      throw new Error('Could not find /agenda.md in the documents project - check sync completed');
    }

    // Grab meeting info
    const mdText = fileContents.getText('text').toString();
    const thirdHeaderPos = mdText.split('##', 3).join('##').length;
    const cutText = mdText.substring(0, thirdHeaderPos);
    const html = markdown(cutText);

    // Read email template and splice in the agenda
    let email = fs.readFileSync('./mail-template.html', 'utf-8');
    const hr1 = email.indexOf('<hr>') + 4;
    const hr2 = email.indexOf('<hr>', hr1);
    email = email.substring(0, hr1) + html + email.substring(hr2);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: AGENT_EMAIL,
        pass: AGENT_EMAIL_PASSWORD,
      },
    });

    transporter.sendMail(
      {
        from: AGENT_EMAIL,
        to: MAIL_TO,
        bcc: MAIL_BCC,
        subject: 'NDN Weekly Call',
        html: email,
      },
      (error: Error | null, info: nodemailer.SentMessageInfo) => {
        if (error) {
          console.log(error);
        } else {
          console.log('Email sent: ' + info.response);
          process.exit(0);
        }
      },
    );
  });

  await chat.sendMessage(channelName, {
    uuid: '', // auto-generated
    user: await ndn.api.get_identity_name(),
    ts: Date.now(),
    message: 'input',
  });

  // Keep running
  await new Promise(() => {}); // Wait forever
}

async function startHttpServer() {
  const app = express();
  app.use(express.json());
  app.use(
    cors({
      origin: '*',
      methods: ['POST'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  app.post('/agent', async (req: express.Request, res: express.Response) => {
    try {
      let { wkspName, psk, channel } = req.body;

      const pskBuffer = Buffer.from(psk, 'hex');
      if (pskBuffer.length !== 32) {
        throw new Error('PSK must be exactly 32 bytes (64 hex characters)');
      }
      const pskArray = new Uint8Array(pskBuffer);

      // Save original hex string, not the Uint8Array
      fs.writeFileSync('./wksp.env', JSON.stringify({ wkspName, psk, channel }));

      startAgent(wkspName, pskArray, channel);

      res.json({ ok: true, message: `Agent joined workspace ${wkspName} on #${channel}` });
    } catch (err: any) {
      console.error('Invite failed:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  const PORT = parseInt(process.env.AGENT_PORT ?? '3000');
  app.listen(PORT, () => {
    console.log(`Agent server listening on http://localhost:${PORT}`);
  });
}

async function loadServices() {
  globalThis._o = {
    stats: new NodeStatsDb(),
    ProjDb: NodeProjDb,
  };
}

async function loadGoEnvironment() {
  // Go's wasm_exec.js expects a global fs with the Node fs API
  (globalThis as any).fs = fs;

  const wasm_exec = '../../public/wasm_exec.js';
  await import(wasm_exec);
  console.log('Go environment loaded');
}

async function setupWorkspace(wkspName: string, psk: Uint8Array): Promise<Workspace> {
  // Join the workspace if not already joined
  let wkspMeta = await globalThis._o.stats.get(wkspName);
  if (!wkspMeta) {
    await Workspace.join(wkspName, wkspName, false, true, psk);
    wkspMeta = await globalThis._o.stats.get(wkspName);
  }
  if (!wkspMeta) throw new Error(`Workspace metadata missing for ${wkspName}`);

  // Force workspace to ignore invalid certs
  wkspMeta.ignore = true;
  await globalThis._o.stats.put(wkspName, wkspMeta);

  return await Workspace.setup(utils.escapeUrlName(wkspName));
}

main();
