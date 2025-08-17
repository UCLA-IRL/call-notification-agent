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
    await Workspace.join(wkspName, wkspName, false, false, psk);
  }

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

async function main() {
  if (process.argv.length < 3) {
    console.error('Usage: npx tsx src/node/headless.ts <workspace-name> [channel-name] [email] [psk-hex]');
    console.error('  workspace-name: Name of the existing workspace to join');
    console.error('  channel-name: (optional) Name of the chat channel to join');
    console.error('  email: (optional) Email for NDN identity, will prompt if not provided');
    console.error('  psk-hex: (optional) 32-byte workspace PSK in hex format, will prompt if not provided');
    console.error('');
    console.error('Note: This tool joins existing workspaces for chat. You must have the workspace PSK.');
    console.error('      If no channel-name is provided, will list available channels.');
    process.exit(1);
  }

  const wkspName = process.argv[2];
  
  // Parse remaining arguments - could be [channel, email, psk] or [email, psk] or [psk]
  let channelName: string | undefined;
  let email: string | undefined;
  let pskHex: string | undefined;
  
  const remainingArgs = process.argv.slice(3);
  
  // Check if last argument looks like a hex PSK (64 chars)
  const lastArg = remainingArgs[remainingArgs.length - 1];
  if (lastArg && lastArg.length === 64 && /^[0-9a-fA-F]+$/.test(lastArg)) {
    pskHex = lastArg;
    remainingArgs.pop();
  }
  
  // Check if second-to-last argument looks like email
  const secondLastArg = remainingArgs[remainingArgs.length - 1];
  if (secondLastArg && secondLastArg.includes('@')) {
    email = secondLastArg;
    remainingArgs.pop();
  }
  
  // Remaining argument is channel name (if any)
  if (remainingArgs.length > 0) {
    channelName = remainingArgs[0];
  }

  // Get email if not provided
  if (!email) {
    email = await askInput('Enter email address: ');
  }

  // Get PSK (required for joining existing workspace)
  let psk: Uint8Array;
  if (!pskHex) {
    pskHex = await askInput('Enter workspace PSK (32 bytes hex): ');
  }
  
  const pskBuffer = Buffer.from(pskHex, 'hex');
  if (pskBuffer.length !== 32) {
    throw new Error('PSK must be exactly 32 bytes (64 hex characters)');
  }
  psk = new Uint8Array(pskBuffer);

  try {
    await loadServices();
    await loadGoEnvironment();
    
    await ndn.setup();
    
    // Connect to testbed 
    await ndn.api.connect_testbed();
    
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

    // Setup the workspace
    const wksp = await setupWorkspace(wkspName, psk);
    
    // Setup chat
    console.log(`Joined workspace '${wkspName}'`);
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for sync
    
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
    
    // Listen for new messages
    chat.events.on('chat', (msgChannelName, message) => {
      if (msgChannelName === channelName) {
        const timestamp = new Date(message.ts).toLocaleTimeString();
        console.log(`[${timestamp}] ${message.user}: ${message.message}`);
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
  } catch (e) {
    console.error('FATAL:', e);
    process.exit(1);
  }
}

main();
