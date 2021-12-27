"use strict";

import {
  NAN_BLOCK_ADDRESS,
  ZERO_BLOCK_ADDRESS,
  ADDRESSES_IN_BLOCK,
} from "./constants.js";
import Device from "./device.js";
import INode, { FileType } from "./inode.js";
import Dentry from "./dentry.js";
import {
  FileAlreadyExist,
  InvalidArgument,
  InvalidPath,
  OutOfBounds,
} from "./exceptions.js";
import {
  deserializeDentries,
  serializeDentry,
  deserializeAddresses,
  serializeDentries,
  serializeInt32,
  serializeInode,
  deserializeInt32,
  deserializeInode,
  serializeAddress,
  serializeAddresses,
} from "./serializer.js";
import { v4 as uuidv4 } from "uuid";
import {
  ADDRESS_SIZE,
  BLOCK_COUNT,
  BLOCK_SIZE,
  DENTRY_SIZE,
  INODE_SIZE,
  INODE_STRAIGHT_LINKS_COUNT,
  N_SIZE,
  MAX_SYMLINK_DEPTH,
} from "./settings.js";

/**
 * @classdesc File system driver for block device
 *
 * @exports Driver
 */
class Driver {
  /**
   * File sytem driver
   * @constructor
   *
   * @param {Device} device Block device
   */
  constructor(device) {
    this.device = device;
    this.openFiles = {};
    this.cwdIno = 0;
  }

  /**
   * @param {number} n Max count of file descriptors
   *
   * @throws {InvalidArgument} Argument n must be more then 1
   */
  mkfs(n) {
    // 1. clean bitmap
    // 2. set n
    // 3. create n unused file descriptors
    // 4. add root descriptor (directory)
    const fsMetadata = new Uint8Array(
      Math.ceil(BLOCK_COUNT / 8) + 4 + n * INODE_SIZE
    );
    const unfreeBlocks = Math.ceil(fsMetadata.length / BLOCK_SIZE);

    for (let blockAddress = 0; blockAddress < unfreeBlocks; blockAddress++) {
      const block = new Uint8Array(BLOCK_SIZE);
      fsMetadata.copyWithin(
        block,
        blockAddress * BLOCK_SIZE,
        (blockAddress + 1) * BLOCK_SIZE
      );
      this.device.writeBlock(blockAddress, block);
    }

    for (let blockIndex = 0; blockIndex < unfreeBlocks; blockIndex++) {
      this._setBlockUnfree(blockIndex);
    }

    this._setN(n);

    const root = new INode(
      0,
      FileType.DIRECTORY,
      0,
      0,
      [],
      NAN_BLOCK_ADDRESS,
      NAN_BLOCK_ADDRESS
    );

    this._updateDescriptor(root);
    this._addLink(root, root, ".");
    this._addLink(root, root, "..");
  }

  /**
   * Link regular file with new file name
   *
   * @param {string} filePath1 Path to existen file
   * @param {string} filePath2 New file name that must be link to file descriptor
   *
   * @throws {InvalidPath} File by `filePath1` must exist
   * @throws {InvalidPath} File by `filePath1` must regular
   * @throws {InvalidPath} Directory by `filePath2` must exist
   * @throws {FileAlreadyExist} File by `filePath2` must not exist
   */
  link(filePath1, filePath2) {
    // 1. get `file` as inode by `filePath1`
    //    - `file` must be reqular file
    // 2. get `filename` and `dirPath` by `filePath2`
    // 3. get `dir` as inode by `dirPath`
    // 4. add to `dir` new dentry that link (`file`,`filename`)
    const file = this.lookUp(filePath1);
    if (file.type != FileType.REGULAR) {
      throw new InvalidPath("File must be regular");
    }
    const filename = this._getFileName(filePath2);
    const dirPath = this._getDirPath(filePath2);
    const dir = this.lookUp(dirPath);
    this._addLink(dir, file, filename);
  }

  /**
   * Unlink regular file
   *
   * @param {string} filePath Path to regular file
   * @throws {InvalidPath} File by `filePath` must exist
   */
  unlink(filePath) {
    // 1. get `file` as inode by `filePath`
    //    - `file` must be reqular file or symlink
    // 2. get `dirPath` from `filePath`
    // 3. get `dir` as inode by `dirPath`
    //    - `dir` must be directory file
    // 4. remove dentry with `filename` from `dir`
    const file = this.lookUp(filePath);
    if (file.type == FileType.DIRECTORY) {
      throw new InvalidPath("Cannot unlink directory");
    }
    const filename = this._getFileName(filePath);
    const dirPath = this._getDirPath(filePath);
    const dir = this.lookUp(dirPath);
    this._unlink(dir, filename);
  }

  /**
   * Create file by path
   *
   * @param {string} filePath Path to new file
   * @throws {FileAlreadyExist} File by `filePath` must not exist
   * @throws {InvalidPath} Direcotry by `filePath` must exist
   */
  create(filePath) {
    // 1. get `dirPath` and `filename` from `filePath`
    // 2. get `dir` as inode by `dirPath`
    //    - `dir` must be directory file
    // 3. find unused descriptor
    // 4. set it as regular file
    // 5. add to `dir` new dentry that link (`file`,`filename`)
    const filename = this._getFileName(filePath);
    const dirPath = this._getDirPath(filePath);
    const dir = this.lookUp(dirPath);
    if (dir.type != FileType.DIRECTORY) {
      throw new InvalidPath("Directory not found");
    }
    const file = this._getUnusedDescriptor();
    file.type = FileType.REGULAR;
    file.refs = 0;
    file.size = 0;
    file.singleIndirect = 0;
    file.straightLinks = [];
    this._updateDescriptor(file);
    this._addLink(dir, file, filename);
  }

  /**
   * Find file descriptor by id
   *
   * @param {int} ino File descriptor id
   * @returns {INode} File descriptor
   *
   * @throws {DescriptorNotFound} If `inodeId` more them max descriptor count (n)
   */
  getDescriptor(ino) {
    const startAddress = Math.ceil(BLOCK_COUNT / 8) + 4;
    const inodeAddress = startAddress + ino * INODE_SIZE;
    const inodeBlockAddress = Math.ceil(inodeAddress / BLOCK_SIZE);
    const inodeAddressInBlock = inodeAddress % BLOCK_SIZE;

    const block = this.device.readBlock(inodeBlockAddress);
    const inodeBytes = block.subarray(
      inodeAddressInBlock,
      inodeAddressInBlock + INODE_SIZE
    );
    const inode = deserializeInode(inodeBytes);
    inode.ino = ino;
    return inode;
  }

  /**
   * Find file descriptor id by file path
   *
   * @param {string} filePath Path to any file
   * @param {boolean}  resolveSymlink If need to resolve symlink true, othewise false
   * @returns {INode} File descriptor
   *
   * @throws {InvalidPath} File by `filePath` must exist
   */
  lookUp(
    filePath,
    resolveSymlink = false,
    symlinkDepth = null,
    baseDirectory = null
  ) {
    if (symlinkDepth === null) {
      symlinkDepth = { depth: 0 };
    }
    if (baseDirectory === null) {
      baseDirectory = this.getDescriptor(this.cwdIno);
    }

    if (filePath == "/") return this.getDescriptor(0);
    if (filePath == "") return baseDirectory;

    const filename = this._getFileName(filePath);
    const dirPath = this._getDirPath(filePath);
    const dir =
      dirPath == ""
        ? baseDirectory
        : this.lookUp(dirPath, true, symlinkDepth, baseDirectory);
    const dentries = this._readDirectory(dir);
    for (let dentry of dentries) {
      if (dentry.fileName == filename) {
        const file = this.getDescriptor(dentry.ino);
        if (file.type != FileType.SYMLINK || !resolveSymlink) {
          return file;
        }
        let symlink = file;
        if (symlinkDepth.depth < MAX_SYMLINK_DEPTH) {
          const linkPathBytes = this._read(symlink, 0, symlink.size);
          const linkPath = new TextDecoder().decode(linkPathBytes);
          symlinkDepth.depth++;
          return this.lookUp(linkPath, true, symlinkDepth, dir);
        }

        throw new Error("Symlink max depth overlapce");
      }
    }

    throw new InvalidPath("File not found");
  }

  /**
   * Read all dentries of directory
   *
   * @param {string} dirPath Path to directory
   * @returns {Dentry[]} Directory denties
   *
   * @throws {InvalidPath} Directory by `dirPath` must exist
   */
  readDirectory(dirPath) {
    const dir = this.lookUp(dirPath);
    if (dir.type != FileType.DIRECTORY) {
      throw new InvalidPath("Directory not found");
    }
    return this._readDirectory(dir);
  }

  /**
   * Open file by file path and return numeric file descriptor
   *
   * @param {string} filePath Path to regular file
   * @returns {string} Numeric file descriptor
   * @throws {InvalidPath} File by `filePath` must exist
   */
  open(filePath) {
    const file = this.lookUp(filePath);
    if (file.type != FileType.REGULAR) {
      throw new InvalidPath("File not found");
    }

    const numericInode = uuidv4();
    this.openFiles[numericInode] = file.ino;
    return numericInode;
  }

  /**
   * Close file by numeric file descriptor
   *
   * @param {string} numericinode Numeric file descriptor
   * @throws {InvalidArgument} File by `numericInode` must be opened
   */
  close(numericInode) {
    delete this.openFiles[numericInode];
  }

  /**
   * Read data from opened file
   *
   * @param {string} numericinode Numeric file descriptor
   * @param {int} offset Offset from file start
   * @param {int} size Size of read data
   *
   * @returns {Uint8Array} File bytes
   *
   * @throws {InvalidArgument} File by `numericInode` must be opened
   * @throws {OutOfBounds} Bytes what need to be read must exist
   */
  read(numericInode, offset, size) {
    const ino = this.openFiles[numericInode];
    if (!ino) {
      throw new InvalidArgument(`File by ${numericInode} must be opened`);
    }

    const file = this.getDescriptor(ino);
    return this._read(file, offset, size);
  }

  /**
   * Write buffer data to open file
   *
   * @param {string} numericinode Numeric file descriptor
   * @param {int} offset Offset from file start
   * @param {int} buffer Buffer with data what must be write to file
   *
   * @throws {InvalidArgument} File by `numericInode` must be opened
   * @throws {OutOfBounds} Connot write out of file size
   */
  write(numericInode, offset, buffer) {
    const ino = this.openFiles[numericInode];
    if (!ino) {
      throw new InvalidArgument(`File by ${numericInode} must be opened`);
    }

    const file = this.getDescriptor(ino);
    return this._write(file, offset, buffer);
  }

  /**
   * Change regular file size (increase or decrease)
   *
   * @param {string} filePath Path to regular file
   * @param {int} size New file descriptor size
   *
   * @throws {InvalidPath} File by `filePath` must exist
   * @throws {NotEnoughMemory} If not found free space on device
   */
  truncate(filePath, size) {
    const file = this.lookUp(filePath);
    if (file.type != FileType.REGULAR) {
      throw new InvalidPath("File must be regular");
    }

    this._truncate(file, size);
  }

  /**
   * Create directory
   *
   * @param {string} dirPath Path where dir must be created
   */
  mkdir(dirPath) {
    let newDir = null;

    try {
      const dirName = this._getFileName(dirPath);
      const parentDirPath = this._getDirPath(dirPath);

      const parentDir = this.lookUp(parentDirPath);
      if (parentDir.type != FileType.DIRECTORY) {
        throw new InvalidPath("Directory not found");
      }
      newDir = this._getUnusedDescriptor();
      newDir.type = FileType.DIRECTORY;
      newDir.refs = 0;
      newDir.size = 0;
      newDir.singleIndirect = 0;
      newDir.straightLinks = [];
      this._updateDescriptor(newDir);
      this._addLink(parentDir, newDir, dirName);
      this._addLink(newDir, newDir, ".");
      this._addLink(newDir, parentDir, "..");
    } catch (e) {
      if (e instanceof FileAlreadyExist) {
        newDir.refs = 0;
        this._removeOrUpdate(newDir);
      }
      throw e;
    }
  }

  /**
   * Remove directory
   *
   * @param {string} dirPath Path to dir
   *
   * @throws {InvalidPath} Directory by `dirPath` must exist
   */
  rmdir(dirPath) {
    const dirName = this._getFileName(dirPath);
    const parentDirPath = this._getDirPath(dirPath);
    let dir = this.lookUp(dirPath);

    if (dir.type != FileType.DIRECTORY) {
      throw new InvalidPath("Directory not found");
    }
    if (dir.refs > 2) {
      throw new Error("Dir is not empty");
    }

    this._unlink(dir, ".");
    dir = this.lookUp(dirPath);
    this._unlink(dir, "..");
    const parentDir = this.lookUp(parentDirPath);
    this._unlink(parentDir, dirName);
  }

  /**
   * Create symlink
   *
   * @param {string} filePath Path to file
   * @param {string} linkPath Symlick path
   */
  symlink(filePath, linkPath) {
    let symlink;

    try {
      const linkPathBytes = new TextEncoder().encode(linkPath);
      const fileName = this._getFileName(filePath);
      const dirPath = this._getDirPath(filePath);

      const dir = this.lookUp(dirPath);
      if (dir.type != FileType.DIRECTORY) {
        throw new InvalidPath("Directory not found");
      }

      symlink = this._getUnusedDescriptor();
      symlink.type = FileType.SYMLINK;
      symlink.refs = 0;
      symlink.size = 0;
      symlink.singleIndirect = 0;
      symlink.straightLinks = [];
      this._updateDescriptor(symlink);
      this._addLink(dir, symlink, fileName);
      this._truncate(symlink, linkPath.length);
      symlink = this.getDescriptor(symlink.ino);
      this._write(symlink, 0, linkPathBytes);
    } catch (e) {
      if (e instanceof FileAlreadyExist) {
        this._removeOrUpdate(symlink);
      }

      throw e;
    }
  }

  /**
   *
   * @param {string} dirPath
   */
  cd(dirPath) {
    const dir = this.lookUp(dirPath);
    this.cwdIno = dir.ino;
  }

  /**
   * @return {string} Process work directory
   */
  pwd() {
    if (this.cwdIno == 0) {
      return "/";
    }

    let dir = this.getDescriptor(this.cwdIno);
    let dentries = this._readDirectory(dir);
    let path = "";
    while (
      dentries.find((d) => d.fileName == ".").ino !=
      dentries.find((d) => d.fileName == "..").ino
    ) {
      console.log(dentries);
      const parentDirIno = dentries.find((d) => d.fileName == "..").ino;
      const parentDir = this.getDescriptor(parentDirIno);
      const parentDentries = this._readDirectory(parentDir);
      const currentDirName = parentDentries.find(
        (d) => d.ino == dir.ino
      ).fileName;
      path = "/" + currentDirName + path;
      dir = parentDir;
      dentries = this._readDirectory(dir);
    }

    return path;
  }

  /**
   *
   * @param {int} n
   */
  _setN(n) {
    const nAddress = Math.ceil(BLOCK_COUNT / 8);
    const nBlockAddress = Math.floor(nAddress / BLOCK_SIZE);
    const nAddressInBlock = nAddress % BLOCK_SIZE;
    const nBytes = serializeInt32(n);

    const block = this.device.readBlock(nBlockAddress);
    block.set(nBytes, nAddressInBlock);
    this.device.writeBlock(nBlockAddress, block);
  }

  _getN() {
    const nAddress = Math.ceil(BLOCK_COUNT / 8);
    const nBlockAddress = Math.floor(nAddress / BLOCK_SIZE);
    const nAddressInBlock = nAddress % BLOCK_SIZE;

    const block = this.device.readBlock(nBlockAddress);
    const nBytes = block.subarray(nAddressInBlock, nAddressInBlock + N_SIZE);
    const n = deserializeInt32(nBytes);
    return n;
  }

  /**
   *
   * @param {INode} dir
   * @param {string} filename
   */
  _unlink(dir, filename) {
    const dentries = this._readDirectory(dir);
    const removeDentry = dentries.find((d) => d.fileName == filename);
    const newDentries = dentries.filter((d) => d.fileName != filename);
    const newDentriesData = serializeDentries(newDentries);
    this._write(dir, 0, newDentriesData);
    this._truncate(dir, dir.size - DENTRY_SIZE); // Can be optimize

    const file = this.getDescriptor(removeDentry.ino);
    file.refs--;
    this._removeOrUpdate(file);
  }

  /**
   *
   * @param {INode} inode
   */
  _removeOrUpdate(inode) {
    if (inode.refs == 0) {
      this._truncate(inode, 0);
      inode.type = FileType.UNUSED;
      inode.size = 0;
      inode.singleIndirect = NAN_BLOCK_ADDRESS;
      inode.doubleIndirect = NAN_BLOCK_ADDRESS;
      inode.straightLinks = [];
      for (
        let linkIndex = 0;
        linkIndex < INODE_STRAIGHT_LINKS_COUNT;
        linkIndex++
      ) {
        inode.straightLinks.push(NAN_BLOCK_ADDRESS);
      }
    }

    this._updateDescriptor(inode);
  }

  /**
   *
   * @param {INode} dir
   * @returns
   */
  _readDirectory(dir) {
    const dirData = this._read(dir, 0, dir.size);
    const dentries = deserializeDentries(dirData);
    return dentries;
  }

  /**
   * Change file size (any type of file)
   *
   * @param {INode} inode File descriptor
   * @param {int} size New file size
   *
   * @throws {NotEnoughMemory} If not found free space on device
   */
  _truncate(inode, size) {
    if (inode.size < size) {
      this._increaseINode(inode, size);
    } else {
      this._descreaseINode(inode, size);
    }
  }

  /**
   *
   * @param {INode} inode
   * @param {int} size
   */
  _increaseINode(inode, size) {
    const blockExists = Math.ceil(inode.size / BLOCK_SIZE);
    const needBlocks = Math.ceil(size / BLOCK_SIZE);

    const newFreeBlockAddresses = [];
    for (
      let newFreeBlockIndex = 0;
      newFreeBlockIndex < needBlocks - blockExists;
      newFreeBlockIndex++
    ) {
      const newFreeBlockAddress = ZERO_BLOCK_ADDRESS;
      newFreeBlockAddresses.push(newFreeBlockAddress);
    }

    this._appendBlockToINode(inode, newFreeBlockAddresses);
    let updatedINode = Object.assign({}, inode);
    updatedINode.size = size;
    this._updateDescriptor(updatedINode);
  }

  /**
   *
   * @param {INode} inode
   * @param {int} size
   */
  _descreaseINode(inode, size) {
    const blockExists = Math.ceil(inode.size / BLOCK_SIZE);
    const needBlocks = Math.ceil(size / BLOCK_SIZE);
    const removeBlocksCount = blockExists - needBlocks;
    this._removeLastBlocksFromINode(inode, removeBlocksCount);
    const blockAddresses = [...this._getBlocks(inode)];
    if (blockAddresses.length == 0) {
      inode.size = size;
      return this._updateDescriptor(inode);
    }
    const lastBlockAddress = blockAddresses[blockAddresses.length - 1];
    const lastBlockByteCount = size % BLOCK_SIZE;
    if (lastBlockByteCount != 0) {
      const lastBlock = this.device.readBlock(lastBlockAddress);
      lastBlock.set(
        new Uint8Array(BLOCK_SIZE - lastBlockByteCount),
        lastBlockByteCount
      );
      this.device.writeBlock(lastBlockAddress, lastBlock);
    }

    inode.size = size;
    this._updateDescriptor(inode);
  }

  /**
   *
   * @param {INode} inode
   * @param {int} removeBlocksCount
   */
  _removeLastBlocksFromINode(inode, removeBlocksCount) {
    let blockExists = Math.ceil(inode.size / BLOCK_SIZE);
    const blockAddresses = [...this._getBlocks(inode)];

    for (let removeCount = 0; removeCount < removeBlocksCount; removeCount++) {
      const blockAddress = blockAddresses.pop();
      this._setBlockFree(blockAddress);
    }

    if (inode.doubleIndirect != NAN_BLOCK_ADDRESS) {
      const singleIndirectCount = Math.ceil(
        (blockExists - INODE_STRAIGHT_LINKS_COUNT - ADDRESSES_IN_BLOCK) /
          ADDRESSES_IN_BLOCK
      );
      const singleIndirectEnough = Math.max(
        0,
        Math.ceil(
          (blockExists -
            removeBlocksCount -
            INODE_STRAIGHT_LINKS_COUNT -
            ADDRESSES_IN_BLOCK) /
            ADDRESSES_IN_BLOCK
        )
      );
      const needToRemove = singleIndirectCount - singleIndirectEnough;
      const doubleIndirectBlock = this.device.readBlock(inode.doubleIndirect);
      const addresses = deserializeAddresses(
        doubleIndirectBlock.slice(0, singleIndirectCount * ADDRESS_SIZE)
      );
      for (let blockRemove = 0; blockRemove < needToRemove; blockRemove++) {
        this._setBlockFree(addresses.pop());
      }

      const addressesData = serializeAddresses(addresses);
      const buff = new Uint8Array(BLOCK_SIZE);
      buff.set(addressesData, 0);

      this.device.writeBlock(inode.doubleIndirect, buff);

      if (addresses.length == 0) {
        inode.doubleIndirect = NAN_BLOCK_ADDRESS;
        this._updateDescriptor(inode);
      }
    }
    if (inode.singleIndirect != NAN_BLOCK_ADDRESS) {
      const enoughBlockInSingleIndirect = Math.min(
        Math.max(
          0,
          blockExists - removeBlocksCount - INODE_STRAIGHT_LINKS_COUNT
        ),
        ADDRESSES_IN_BLOCK
      );
      const singleIndirectBlock = this.device.readBlock(inode.singleIndirect);
      const buff = new Uint8Array(BLOCK_SIZE);
      singleIndirectBlock.copyWithin(
        buff,
        0,
        enoughBlockInSingleIndirect * ADDRESS_SIZE
      );
      this.device.writeBlock(inode.singleIndirect, buff);

      if (enoughBlockInSingleIndirect == 0) {
        inode.singleIndirect = NAN_BLOCK_ADDRESS;
        this._updateDescriptor(inode);
      }
    }
    if (blockExists - removeBlocksCount < INODE_STRAIGHT_LINKS_COUNT) {
      for (
        let linkIndex = blockExists - removeBlocksCount;
        linkIndex < INODE_STRAIGHT_LINKS_COUNT;
        linkIndex++
      ) {
        inode.straightLinks[linkIndex] = NAN_BLOCK_ADDRESS;
      }
      this._updateDescriptor(inode);
    }
  }

  _getFreeBlockAddress() {
    const bitmapSize = Math.ceil(BLOCK_COUNT / 8);
    const bitmap = new Uint8Array(bitmapSize);
    for (
      let blockIndex = 0;
      blockIndex * BLOCK_SIZE < bitmapSize;
      blockIndex++
    ) {
      const block = this.device.readBlock(blockIndex);
      bitmap.set(
        block.subarray(0, bitmapSize - blockIndex * BLOCK_SIZE),
        blockIndex * BLOCK_SIZE
      );
    }

    for (let byteIndex = 0; byteIndex < bitmap.length; byteIndex++) {
      const byte = bitmap[byteIndex];

      for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
        if (!(byte & (1 << bitIndex))) {
          return byteIndex * 8 + bitIndex;
        }
      }
    }
  }

  /**
   *
   * @param {INode} inode
   * @param {int[]} blockAddreses
   */
  _appendBlockToINode(inode, blockAddreses) {
    if (blockAddreses.length == 0) return;

    let blockExists = Math.ceil(inode.size / BLOCK_SIZE);
    while (blockExists < INODE_STRAIGHT_LINKS_COUNT) {
      inode.straightLinks[blockExists++] = blockAddreses.pop(0);
      if (blockAddreses.length == 0) {
        return this._updateDescriptor(inode);
      }
    }

    if (inode.singleIndirect == NAN_BLOCK_ADDRESS) {
      inode.singleIndirect = this._getFreeBlockAddress();
      this._setBlockUnfree(inode.singleIndirect);
      this._clearBlock(inode.singleIndirect);
    }

    const singleIndirectBlock = this.device.readBlock(inode.singleIndirect);
    while (blockExists < INODE_STRAIGHT_LINKS_COUNT + ADDRESSES_IN_BLOCK) {
      const address = blockAddreses.pop(0);
      const addressBytes = serializeAddress(address);
      const offset = (blockExists - INODE_STRAIGHT_LINKS_COUNT) * ADDRESS_SIZE;

      singleIndirectBlock.set(addressBytes, offset);

      blockExists++;
      if (blockAddreses.length == 0) {
        this.device.writeBlock(inode.singleIndirect, singleIndirectBlock);
        return this._updateDescriptor(inode);
      }
    }
    this.device.writeBlock(inode.singleIndirect, singleIndirectBlock);

    if (inode.doubleIndirect == NAN_BLOCK_ADDRESS) {
      inode.doubleIndirect = this._getFreeBlockAddress();
      this._setBlockUnfree(inode.doubleIndirect);
      this._clearBlock(inode.doubleIndirect);
    }

    const doubleIndirectBlock = this.device.readBlock(inode.doubleIndirect);
    const singleIndirectBlockIndex = 0;
    while (
      blockExists <
      INODE_STRAIGHT_LINKS_COUNT +
        ADDRESSES_IN_BLOCK +
        ADDRESSES_IN_BLOCK * ADDRESSES_IN_BLOCK
    ) {
      const offset =
        ADDRESS_SIZE *
        Math.floor(
          (blockExists - INODE_STRAIGHT_LINKS_COUNT - ADDRESSES_IN_BLOCK) /
            ADDRESSES_IN_BLOCK
        );
      let singleIndirectAddressBytes = doubleIndirectBlock.subarray(
        offset,
        offset + ADDRESS_SIZE
      );
      let singleIndirectAddress = serializeAddress(singleIndirectAddressBytes);

      if (singleIndirectAddress == NAN_BLOCK_ADDRESS) {
        singleIndirectAddress = this._getFreeBlockAddress();
        this._setBlockUnfree(singleIndirectAddress);
        this._clearBlock(singleIndirectAddress);

        singleIndirectAddressBytes = serializeAddress(singleIndirectAddress);
        doubleIndirectBlock.set(singleIndirectAddressBytes, offset);
      }

      const singleIndirectBlock = this.device.readBlock(singleIndirectAddresss);
      while (
        blockExists <
        INODE_STRAIGHT_LINKS_COUNT +
          ADDRESSES_IN_BLOCK +
          ADDRESSES_IN_BLOCK * (singleIndirectBlockIndex + 1)
      ) {
        const address = blockAddreses.pop(0);
        const addressBytes = serializeAddress(address);
        const offset =
          ADDRESS_SIZE *
          ((blockExists - INODE_STRAIGHT_LINKS_COUNT) % ADDRESSES_IN_BLOCK);
        singleIndirectBlock.set(addressBytes, offset);

        blockExists++;

        if (blockAddreses.length == 0) {
          this.device.writeBlock(singleIndirectAddresss, singleIndirectBlock);
          this.device.writeBlock(inode.doubleIndirect, doubleIndirectBlock);
          return this._updateDescriptor(inode);
        }
      }
      this.device.writeBlock(singleIndirectAddresss, singleIndirectBlock);

      singleIndirectBlockIndex++;
    }
    this.device.writeBlock(inode.doubleIndirect, doubleIndirectBlock);
    this._updateDescriptor(inode);

    throw new Error("Not enough double indirect");
  }

  /**
   * Add new dentry to directory
   *
   * @param {INode} dir Directory file descriptor
   * @param {INode} file File descriptor
   * @param {string} filename File name
   *
   * @throws {FileAlreadyExist} File with `fileName` must not exist in directory
   */
  _addLink(dir, file, filename) {
    const dentries = this._readDirectory(dir);
    const fileAlreadyExist = dentries.find(
      (dentry) => dentry.fileName == filename
    );
    if (fileAlreadyExist) {
      throw new FileAlreadyExist();
    }
    const newDentry = new Dentry(filename, file.ino);
    const newDentryData = serializeDentry(newDentry);
    this._truncate(dir, dir.size + DENTRY_SIZE);
    dir.size += DENTRY_SIZE;
    this._write(dir, dir.size - DENTRY_SIZE, newDentryData);
    file.refs++;
    this._updateDescriptor(file);
  }

  /**
   *
   * @param {INode} inode
   * @param {int} startBlockIndex
   * @param {int} endBlockIndex
   *
   * @yields {int} Block addresses
   */
  *_getBlocks(inode, startBlockIndex = 0, endBlockIndex = -1) {
    let blockIndex = startBlockIndex;
    if (blockIndex < inode.straightLinks.length) {
      for (let blockAddress of inode.straightLinks.slice(blockIndex)) {
        if (blockAddress == NAN_BLOCK_ADDRESS) return;
        if (blockIndex == endBlockIndex) return;

        yield blockAddress;
        blockIndex++;
      }
    }
    if (
      blockIndex < inode.straightLinks.length + ADDRESSES_IN_BLOCK &&
      inode.singleIndirect != NAN_BLOCK_ADDRESS
    ) {
      // read from signle indirect
      const singleIndirectBlock = this.device.readBlock(inode.singleIndirect);
      const addresses = deserializeAddresses(singleIndirectBlock);
      for (let blockAddress of addresses) {
        if (blockAddress == NAN_BLOCK_ADDRESS) return;
        if (blockIndex == endBlockIndex) return;

        yield blockAddress;
        blockIndex++;
      }
    }
    if (
      blockIndex <
        inode.straightLinks.length + ADDRESSES_IN_BLOCK * ADDRESSES_IN_BLOCK &&
      inode.doubleIndirect != NAN_BLOCK_ADDRESS
    ) {
      // read from double indirect
      const doubleIndirectBlock = this.device.readBlock(inode.doubleIndirect);
      const singleIndirectAddresses = deserializeAddresses(doubleIndirectBlock);

      for (let singleIndirectAddress of singleIndirectAddresses) {
        if (singleIndirectAddress == NAN_BLOCK_ADDRESS) return;

        const singleIndirectBlock = this.device.readBlock(
          singleIndirectAddress
        );
        const addresses = deserializeAddresses(singleIndirectBlock);
        for (let blockAddress of addresses) {
          if (blockAddress == NAN_BLOCK_ADDRESS) return;
          if (blockIndex == endBlockIndex) return;

          yield blockAddress;
          blockIndex++;
        }
      }
    }
  }

  /**
   *
   * @param {INode} inode
   * @param {int} offset
   * @param {Uint8Array} buffer
   *
   * @throws {OutOfBounds} Connot write out of file size
   */
  _write(inode, offset, buffer) {
    if (inode.size < offset + buffer.length) {
      throw new OutOfBounds();
    }

    const startBlockIndex = Math.floor(offset / this.device.blockSize);
    const endBlockIndex =
      Math.floor((offset + buffer.length) / this.device.blockSize) + 1; // exclusive

    let writenBytes = 0;
    let blockIndexInINode = startBlockIndex;

    for (let blockAddress of this._getBlocks(
      inode,
      startBlockIndex,
      endBlockIndex
    )) {
      if (blockAddress == ZERO_BLOCK_ADDRESS) {
        blockAddress = this._getFreeBlockAddress();
        this._setBlockUnfree(blockAddress);
        this._clearBlock(blockAddress);
        this._setDescriptorBlock(inode, blockIndexInINode, blockAddress);
      }

      const offsetInBlock = offset % this.device.blockSize;
      const writeBytesInBlock = Math.min(
        this.device.blockSize - offsetInBlock,
        buffer.length - writenBytes
      );
      const buf = buffer.subarray(writenBytes, writenBytes + writeBytesInBlock);

      let block = this.device.readBlock(blockAddress);
      block.set(buf, offsetInBlock);
      this.device.writeBlock(blockAddress, block);

      writenBytes += writeBytesInBlock;
      offset += writenBytes;
      blockIndexInINode++;
    }
  }

  /**
   *
   * @param {INode} inode
   * @param {int} blockIndex
   * @param {int} blockAddress
   */
  _setDescriptorBlock(inode, blockIndex, blockAddress) {
    if (blockIndex < INODE_STRAIGHT_LINKS_COUNT) {
      // Straight links
      inode.straightLinks[blockIndex] = blockAddress;
      this._updateDescriptor(inode);
    } else if (blockIndex < INODE_STRAIGHT_LINKS_COUNT + ADDRESSES_IN_BLOCK) {
      // Single indirect
      const singleIndirect = this.device.readBlock(inode.singleIndirect);
      const addresses = deserializeAddresses(singleIndirect);
      addresses[blockIndex] = blockAddress;
      const buff = serializeAddress(addresses);
      this.device.writeBlock(inode.singleIndirect, buff);
    } else {
      // Double indirect
      const singleIndirectIndex = Math.floor(
        (blockIndex - INODE_STRAIGHT_LINKS_COUNT - ADDRESSES_IN_BLOCK) /
          ADDRESSES_IN_BLOCK
      );
      const addressIndex =
        (blockIndex - INODE_STRAIGHT_LINKS_COUNT - ADDRESSES_IN_BLOCK) %
        ADDRESSES_IN_BLOCK;

      const doubleIndirect = this.device.readBlock(inode.doubleIndirect);
      const sindleIndirectAddresses = deserializeAddresses(doubleIndirect);
      const singleIndirectAddress =
        sindleIndirectAddresses[singleIndirectIndex];
      const singleIndirect = this.device.readBlock(singleIndirectAddress);
      const addresses = deserializeAddresses(singleIndirect);
      addresses[addressIndex] = blockAddress;
      const buff = serializeAddress(addresses);
      this.device.writeBlock(singleIndirectAddress, buff);
    }
  }

  /**
   * Read data from inode
   *
   * @param {INode} File descriptor
   * @param {int} offset Offset from file start
   * @param {int} size Size of read data
   *
   * @returns {Uint8Array} File bytes
   *
   * @throws {OutOfBounds} Bytes what need to be read must exist
   */
  _read(inode, offset, size) {
    if (inode.size < offset + size) {
      throw new OutOfBounds();
    }

    const buffer = new Uint8Array(size);

    const startBlockIndex = Math.floor(offset / this.device.blockSize);
    const endBlockIndex =
      Math.floor((offset + size) / this.device.blockSize) + 1; // exclusive

    let readBytes = 0;
    for (let blockAddres of this._getBlocks(
      inode,
      startBlockIndex,
      endBlockIndex
    )) {
      const offsetInBlock = offset % this.device.blockSize;
      const readBytesInBlock = Math.min(
        this.device.blockSize - offsetInBlock,
        size - readBytes
      );

      let block = null;
      if (blockAddres == ZERO_BLOCK_ADDRESS) {
        block = new Uint8Array(BLOCK_SIZE);
      } else {
        block = this.device.readBlock(blockAddres);
      }
      buffer.set(
        block.slice(offsetInBlock, offsetInBlock + readBytesInBlock),
        readBytes
      );

      readBytes += readBytesInBlock;
      offset += readBytes;
    }

    return buffer;
  }

  /**
   *
   * @param {string} filePath File path
   * @returns {string} File name
   */
  _getFileName(filePath) {
    return filePath.substring(filePath.lastIndexOf("/") + 1);
  }

  /**
   *
   * @param {string} filePath File path
   * @returns {string} Directory path
   */
  _getDirPath(filePath) {
    return filePath.substring(0, filePath.lastIndexOf("/"));
  }

  /**
   * File unused descriptor and return it
   *
   * @returns {INode} Unused descriptor
   */
  _getUnusedDescriptor() {
    const n = this._getN();
    for (let ino = 0; ino < n; ino++) {
      const inode = this.getDescriptor(ino);
      if (inode.type == FileType.UNUSED) {
        return inode;
      }
    }

    throw new Error("Unused descriptor not found");
  }

  /**
   *
   * @param {INode} inode
   */
  _updateDescriptor(inode) {
    const startAddress = Math.ceil(BLOCK_COUNT / 8) + 4;
    const inodeAddress = startAddress + inode.ino * INODE_SIZE;
    const inodeBlockAddress = Math.ceil(inodeAddress / BLOCK_SIZE);
    const inodeAddressInBlock = inodeAddress % BLOCK_SIZE;
    const inodeBytes = serializeInode(inode);
    const block = this.device.readBlock(inodeBlockAddress);
    block.set(inodeBytes, inodeAddressInBlock);
    this.device.writeBlock(inodeBlockAddress, block);
  }

  _setBlockUnfree(blockIndex) {
    const bitmapBlockIndex = Math.floor(blockIndex / 8 / BLOCK_SIZE);
    const bitmapByteIndex = Math.floor(blockIndex / 8) % BLOCK_SIZE;
    const bitmapBitIndex = blockIndex % 8;

    const block = this.device.readBlock(bitmapBlockIndex);
    block[bitmapByteIndex] |= 1 << bitmapBitIndex;
    this.device.writeBlock(bitmapBlockIndex, block);
  }

  _setBlockFree(blockIndex) {
    const bitmapBlockIndex = Math.floor(blockIndex / 8 / BLOCK_SIZE);
    const bitmapByteIndex = Math.floor(blockIndex / 8) % BLOCK_SIZE;
    const bitmapBitIndex = blockIndex % 8;

    const block = this.device.readBlock(bitmapBlockIndex);
    block[bitmapByteIndex] &= ~(1 << bitmapBitIndex);
    this.device.writeBlock(bitmapBlockIndex, block);
  }

  _clearBlock(blockAddress) {
    const buff = new Uint8Array(BLOCK_SIZE).fill(0);
    this.device.writeBlock(blockAddress, buff);
  }
}

export default Driver;
