/**
 * Ownly Headless Utility.
 *
 * This synchronizes an Ownly project to the filesystem.
 * Requires Node.js 23 or later.
 */

/// <reference types="node" />
/// <reference types="../services.d.ts" />

import fs from 'fs';
import util from 'util';
import crypto from 'crypto';

import { NodeStatsDb } from '../services/database/stats_node';
import { NodeProjDb } from '../services/database/proj_db_node';
import { getOriginPrivateDirectory } from 'file-system-access';
import nodeAdapter from 'file-system-access/lib/adapters/node.js';

import ndn from '../services/ndn.js';
import { Workspace } from '../services/workspace.js';
import * as utils from '../utils/index.js';

import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { DOMSerializer, Node } from "prosemirror-model";
import { JSDOM } from 'jsdom';
import { mySchema } from './my-schema.ts';
import * as nodemailer from 'nodemailer';

import markdown, { getCodeString } from '@wcj/markdown-to-html'; 

import { ai } from './genkit.js';
import { googleAI } from "@genkit-ai/googleai";

import express from 'express';
import cors from 'cors';

async function main() {
  try {
    await initEnvironment();

    await startHttpServer();
  } catch (e) {
    console.error('FATAL:', e);
    process.exit(1);
  }
}

async function initEnvironment() {
  await loadServices();
  await loadGoEnvironment();

  await ndn.setup();

  // Connect to testbed
  await ndn.api.connect_testbed();

  const email = await askInput('Enter email to use: ');

  // Check if we have a testbed key, if not do NDNCERT
  if (!(await ndn.api.has_testbed_key())) {
    console.log('No NDN testbed certificate found. Starting NDNCERT process...');

    // Start NDNCERT challenge
    console.log(`Starting NDNCERT challenge for ${email}...`);
    await ndn.api.ndncert_email(email, async (status) => {
      switch (status) {
        case 'need-code':
          const code = await askInput('Enter verification code from email: ');
          return code;
        case 'wrong-code':
          console.error('Invalid verification code');
          return '';
        default:
          console.log(`NDNCERT status: ${status}`);
          return '';
      }
    });

    console.log('NDNCERT challenge completed successfully!');
  }
}

async function startAgent(wkspName: string, psk: string, channelName: string) {
  // Setup the workspace
  const wksp = await setupWorkspace(wkspName, psk);

  // Setup chat
  console.log(`Joined workspace '${wkspName}'`);
  await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for sync

  // Record when the agent joined this channel (only fetch messages after this time to ensure context)
  const agentJoinTime = Date.now();

  const chat = await wksp.chat;
  const channels = await chat.getChannels();

  if (!channelName) {
    // List available channels
    console.log('\nAvailable chat channels:');
    if (channels.length === 0) {
      console.log('  No channels found');
    } else {
      channels.forEach(channel => {
        console.log(`  #${channel.name}`);
      });
    }
    process.exit(0);
  }

  // Check if channel exists
  const channel = channels.find(c => c.name === channelName);
  if (!channel) {
    console.log(`Channel #${channelName} not found. Available channels:`);
    channels.forEach(channel => {
      console.log(`  #${channel.name}`);
    });
    process.exit(1);
  }

  console.log(`\nJoined #${channelName}`);
  console.log('===============================================');

  // Display existing messages
  const messages = await chat.getMessages(channelName);
  messages.forEach(msg => {
    const timestamp = new Date(msg.ts).toLocaleTimeString();
    console.log(`[${timestamp}] ${msg.user}: ${msg.message}`);
  });

  console.log('===============================================');
  console.log('Type your messages (press Enter to send, Ctrl+C to quit):');

  // Listen for new messages and respond
  chat.events.on('chat', async (msgChannelName, message) => {
    if (msgChannelName === channelName) {
      const timestamp = new Date(message.ts).toLocaleTimeString();
      console.log(`[${timestamp}] ${message.user}: ${message.message}`);

      const AGENT_ID = 'AGENT: ';

      // ensure agent does not respond to itself
      if (message.message.substring(0, 7) != AGENT_ID) { // use message.user in future

        let text = "";
        text = AGENT_ID + "\nProjects: ";

        for (let i = 0; i < wksp.proj.getProjects().length; i++) {
          console.log(wksp.proj.getProjects())
          const instance = await wksp.proj.get(wksp.proj.getProjects()[i].name)
          text = text + "\n" + instance.name;
        }

        text = text + "\n\nFiles: \n";

        for (let i = 0; i < wksp.proj.getProjects().length; i++) {
          const instance = await wksp.proj.get(wksp.proj.getProjects()[i].name)
          console.log(instance)
          for (let j = 0; j < instance.getFileList().length; j++) {
            text = text + " " + instance.getFileList()[j].path;
          }
          text = text + "\n";
        }

        text += "\n\nagenda.md:\n";

        let fileContents;

        console.log("FILE CONTENTS\n\n\n\n\n\n\n\n")
        console.log(text)


        for (let i = 0; i < wksp.proj.getProjects().length; i++) {
          const instance = await wksp.proj.get(wksp.proj.getProjects()[i].name)
          console.log(instance.getFileList())
          for (let j = 0; j < instance.getFileList().length; j++) {
            console.log(instance.getFileList()[j].path)
            if (instance.getFileList()[j].path == "/agenda.md") {
              fileContents = await instance.getFile(instance.getFileList()[j].path);
            }
          }
        }
        
        await new Promise((resolve) => setTimeout(resolve, 20000));


        console.log(fileContents)

        const map = fileContents.getText('text');

        const mdText = map.toString()

        const thirdHeaderPos = mdText.split("##", 3).join("##").length;

        const cutText = mdText.substring(0, thirdHeaderPos);

        console.log(map)

        const html = markdown(cutText);

        // Read email sample and insert issues

        let email = fs.readFileSync('./mail-template.html', 'utf-8');

        const hr1 = email.indexOf("<hr>") + 4
        const hr2 = email.indexOf("<hr>", hr1)

        email = email.substring(0, hr1) + html + email.substring(hr2)

        console.log(email)

        text += "Sending the following email: \n";

        text += email;

        // Send email via nodemailer

        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
              user: 'ownly.agent@gmail.com',
              pass: 'ojid sxpp zvkb mfli'
          },
        });

        const mailOptions = {
          from: 'ownly-bot',
          to: 'nfd-dev@lists.cs.ucla.edu',
          bcc: 'bradlowe@g.ucla.edu',
          subject: 'NDN Weekly Call',
          html: email
        };

        transporter.sendMail(mailOptions, function(error, info){
          if (error) {
            console.log(error);
          } else {
            console.log('Email sent: ' + info.response);
          }
        });

        await chat.sendMessage(channelName, {
          uuid: '', // auto-generated
          user: await ndn.api.get_identity_name(),
          ts: Date.now(),
          message: text
        });
      }
    }
  });

  // Setup stdin for user input
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (data) => {
    const input = data.toString().trim();
    if (input) {
      await chat.sendMessage(channelName, {
        uuid: '', // auto-generated
        user: await ndn.api.get_identity_name(),
        ts: Date.now(),
        message: input
      });
    }
  });

  // Keep running
  await new Promise(() => {}); // Wait forever
}

async function startHttpServer() {
  const app = express();
  app.use(express.json());
  // Avoid CORS issue
  app.use(cors({
    origin: "*",
    methods: ["POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
  }));

  app.post('/agent', async function(req, res) {
    let { wkspName, psk, channel } = req.body;

    const pskBuffer = Buffer.from(psk, 'hex');
    if (pskBuffer.length !== 32) {
      throw new Error('PSK must be exactly 32 bytes (64 hex characters)');
    }
    psk = new Uint8Array(pskBuffer);

    try {
      // Replace existing agent if running
      if (globalThis._activeAgent) {
        console.log('Stopping previous agent for workspace', globalThis._activeAgent.wkspName);
        // TODO: add cleanup if needed (detach listeners, etc.)
        globalThis._activeAgent = null;
      }

      startAgent(wkspName, psk, channel);

      res.json({ ok: true, message: `Agent joined workspace ${wkspName} on #${channel}` });
    } catch (err: any) {
      console.error('Invite failed:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`Agent server listening on http://localhost:${PORT}`);
  });
}

async function loadServices() {
  globalThis._o = {
    stats: new NodeStatsDb(),
    ProjDb: NodeProjDb,

    getStorageRoot: () => getOriginPrivateDirectory(nodeAdapter, './'),
    streamSaver: null as any, // no node
  };
}

async function loadGoEnvironment() {
  // Prep environment for WebAssembly
  globalThis.TextEncoder = util.TextEncoder;
  /// @ts-expect-error - TextDecoder is not defined in Node
  globalThis.TextDecoder = util.TextDecoder;
  globalThis.performance ??= performance;
  globalThis.crypto ??= crypto as any;

  // Create a proper fs polyfill that matches Go's expectations
  (globalThis as any).fs = {
    ...fs,
    constants: fs.constants,
    // Go-compatible methods
    open: fs.open,
    read: fs.read,
    write: fs.write,
    close: fs.close,
    readdir: fs.readdir,
    mkdir: fs.mkdir,
    stat: fs.stat,
    lstat: fs.lstat,
    readlink: fs.readlink,
    chmod: fs.chmod,
    chown: fs.chown,
    fchmod: fs.fchmod,
    fchown: fs.fchown,
    fstat: fs.fstat,
    fsync: fs.fsync,
    ftruncate: fs.ftruncate,
    lchown: fs.lchown,
    link: fs.link,
    // Add writeSync for compatibility
    writeSync: fs.writeSync || ((fd: any, buffer: any) => fs.writeFileSync(fd, buffer)),
  };

  const wasm_exec = '../../public/wasm_exec.js';
  await import(wasm_exec);
  console.log('Go environment loaded');
}

async function setupWorkspace(wkspName: string, psk: Uint8Array): Promise<Workspace> {
  // Join the workspace if not already joined
  const wkspMeta = await globalThis._o.stats.get(wkspName);
  if (!wkspMeta) {
    await Workspace.join(wkspName, wkspName, false, true, psk);
  }

  // Force workspace to ignore invalid certs
  wkspMeta.ignore = true;
  await globalThis._o.stats.put(wkspName, wkspMeta);

  // Setup the workspace
  return await Workspace.setup(utils.escapeUrlName(wkspName));
}

function askInput(question: string): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(question);
    process.stdin.once('data', data => {
      resolve(data.toString().trim());
    });
  });
}

main();
