import * as Y from 'yjs';

import { GlobalBus } from '@/services/event-bus';
import { SvsProvider } from '@/services/svs-provider';
import * as utils from '@/utils';
import { nanoid } from 'nanoid';

import type { WorkspaceAPI } from './ndn';
import type { IProject, IProjectFile } from './types';

/**
 * Project manager for the workspace.
 * Keeps track of the list of projects and their instances.
 * Each project has its own SVS sync group / provider.
 */
export class WorkspaceProjManager {
  private readonly list: Y.Map<IProject>;
  private readonly instances: Map<string, WorkspaceProj> = new Map();
  public active: WorkspaceProj | null = null;

  private constructor(
    private readonly wksp: WorkspaceAPI,
    private readonly root: Y.Doc,
  ) {
    this.list = this.root.getMap<IProject>('list');

    const listObserver = async () => GlobalBus.emit('project-list', this.getProjects());
    this.list.observe(listObserver);
    listObserver();
  }

  /** Name of the workspace (group) */
  public get group(): string {
    return this.wksp.group;
  }

  /** Create the project manager instance */
  public static async create(
    wksp: WorkspaceAPI,
    provider: SvsProvider,
  ): Promise<WorkspaceProjManager> {
    const doc = await provider.getDoc('proj');
    return new WorkspaceProjManager(wksp, doc);
  }

  /** Destroy the project manager instance */
  public async destroy() {
    await Promise.all(Array.from(this.instances.values()).map((proj) => proj.destroy()));
    this.instances.clear();
    this.root.destroy();
    this.active = null;
  }

  /** Get the list of projects */
  public getProjects(): IProject[] {
    return Array.from(this.list.values());
  }

  /** Create a new project */
  public async newProject(name: string) {
    if (!name) throw new Error('Project name is required');
    if (this.list.has(name)) throw new Error('Project already exists');
    const uuid = nanoid();
    this.list.set(uuid, { uuid, name });
  }

  /** Get a project instance */
  public async get(name: string): Promise<WorkspaceProj> {
    const pmeta = this.getProjects().find((p) => p.name === name);
    const puuid = pmeta?.uuid;
    if (!puuid) throw new Error('Project not found');

    let proj = this.instances.get(puuid);
    if (proj) return proj;

    // Create project instance
    proj = await WorkspaceProj.create(puuid, pmeta.name, this.wksp, this);
    this.instances.set(puuid, proj);
    return proj;
  }
}

/**
 * Project instance for the workspace.
 * Each project has its own SVS sync group / provider.
 */
export class WorkspaceProj {
  private readonly fileMap: Y.Map<IProjectFile>;

  private constructor(
    public readonly uuid: string,
    public readonly name: string,
    private readonly root: Y.Doc,
    private readonly provider: SvsProvider,
    private readonly manager: WorkspaceProjManager,
  ) {
    // Set up file list
    this.fileMap = root.getMap('file_list');
    this.fileMap.observe(() => this.onListChange());
  }

  /**
   * Create a new project instance
   *
   * @param uuid Project uuid
   * @param name Project name (slug)
   * @param wksp Workspace API
   * @param manager Project manager instance
   */
  public static async create(
    uuid: string,
    name: string,
    wksp: WorkspaceAPI,
    manager: WorkspaceProjManager,
  ): Promise<WorkspaceProj> {
    // Start SVS for project
    const provider = await SvsProvider.create(wksp, uuid);

    // Create root document
    const root = await provider.getDoc('root');

    // Create project object
    return new WorkspaceProj(uuid, name, root, provider, manager);
  }

  /** Destroy the project instance */
  public async destroy() {
    this.root.destroy();
    await this.provider.destroy();
  }

  /** Make this the active project */
  public async activate(): Promise<void> {
    this.manager.active = this;
    this.onListChange();
  }

  /** Get the list of files */
  public getFileList(): IProjectFile[] {
    return Array.from(this.fileMap.values());
  }

  /** Callback when the list of files changes */
  private onListChange() {
    if (!this.fileMap || this.manager.active?.root.guid !== this.root.guid) return;
    GlobalBus.emit('project-files', this.uuid, this.getFileList());
  }

  /** Check if a file or folder exists */
  public getFileMeta(path: string): IProjectFile | undefined {
    path = utils.normalizePath(path);
    return this.fileMap.get(path);
  }

  /** Create a new file or folder in the project */
  public async newFile(path: string, is_blob?: boolean) {
    if (!path) throw new Error('File path is required');
    if (this.getFileMeta(path) || this.getFileMeta(path + '/'))
      throw new Error('File or folder already exists');

    // Check for invalid characters
    if (!utils.isPathValid(path)) {
      throw new Error(`Invalid characters in path: ${path}`);
    }

    // Create the file
    path = utils.normalizePath(path);
    const uuid = nanoid();
    const file: IProjectFile = { uuid, path, is_blob };
    this.fileMap.set(path, file);
    return file;
  }

  /** Delete a file or folder in the project */
  public async deleteFile(path: string) {
    path = utils.normalizePath(path);
    const isFolder = path.endsWith('/');

    let deletedCount = 0;
    this.root.transact(() => {
      this.fileMap.forEach((_, fpath) => {
        const matchFolder = isFolder && fpath.startsWith(path);
        const matchFile = fpath === path;
        if (matchFolder || matchFile) {
          this.fileMap.delete(fpath);
          deletedCount++;
        }
      });
    });

    if (!deletedCount) {
      throw new Error(`File or folder not found: ${path}`);
    }
  }

  /**
   * Get the content document for a file
   *
   * @param path File path.
   * @throws {Error} If file path is invalid.
   * @returns The Y.Doc instance for the file.
   */
  public async getFile(path: string): Promise<Y.Doc> {
    const meta = this.getFileMeta(path);
    if (!meta?.uuid) throw new Error(`File not found: ${path}`);
    return await this.provider.getDoc(meta.uuid);
  }

  /**
   * Move a file or folder to a new location.
   *
   * @param oldPath Old file path.
   * @param newPath New file path.
   */
  public async moveFile(oldPath: string, newPath: string) {
    oldPath = utils.normalizePath(oldPath);
    newPath = utils.normalizePath(newPath);

    // Check if moving file to folder and vice versa
    if (oldPath.endsWith('/') !== newPath.endsWith('/')) {
      throw new Error('Cannot move file to folder or vice versa');
    }

    // Check for invalid characters
    if (!utils.isPathValid(newPath)) {
      throw new Error(`Invalid characters in path: ${newPath}`);
    }

    // Check if the new path already exists
    if (this.fileMap.has(newPath)) {
      throw new Error(`File already exists: ${newPath}`);
    }

    // Get all matching files
    const oldIsFolder = oldPath.endsWith('/');
    const oldMetas: IProjectFile[] = this.getFileList().filter((f) => {
      if (f.path === oldPath) return true;
      if (oldIsFolder && f.path.startsWith(oldPath)) return true;
      return false;
    });
    if (!oldMetas.length) {
      throw new Error(`No matching files found: ${oldPath}`);
    }

    // Move all matching files in a single transaction
    this.root.transact(() => {
      for (const meta of oldMetas) {
        const fOldPath = meta.path;
        const fNewPath = fOldPath.replace(oldPath, newPath); // only first occurrence

        const newMeta = structuredClone(meta);
        newMeta.path = fNewPath;
        this.fileMap.delete(fOldPath);
        this.fileMap.set(fNewPath, newMeta);
      }
    });
  }

  /**
   * Repair any issues in the project.
   * This should hopefully never be needed.
   */
  private repair() {
    this.root.transact(() => {
      this.fileMap.forEach((meta, path) => {
        if (!utils.isPathValid(path)) {
          this.fileMap.delete(path);
          console.warn(`Invalid path removed: ${path}`);
        }

        if (meta.path !== path) {
          this.fileMap.delete(path);
          this.fileMap.set(meta.path, meta);
          console.warn(`Path repaired: ${path} => ${meta.path}`);
        }
      });
    });
  }
}
