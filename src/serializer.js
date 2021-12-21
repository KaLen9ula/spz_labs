import Dentry from "./dentry.js";
import INode, { FileType } from "./inode.js";
import {
  ADDRESS_SIZE,
  DENTRY_SIZE,
  INODE_INO_SIZE,
  INODE_REFS_SIZE,
  INODE_SIZE,
  INODE_SIZE_SIZE,
  INODE_STRAIGHT_LINKS_COUNT,
  INODE_TYPE_SIZE,
  N_SIZE,
} from "./settings.js";

/**
 *
 * @param {Dentry} dentry Directory entry
 * @return {Uint8Array} Bytes reprasentation
 */
const serializeDentry = (dentry) => {
  const buff = new Uint8Array(DENTRY_SIZE);
  const filenameBytes = new TextEncoder().encode(
    dentry.fileName.substring(0, DENTRY_SIZE - N_SIZE)
  );

  buff.set(filenameBytes, 0);
  buff.set(serializeInt32(dentry.ino), DENTRY_SIZE - N_SIZE);
  return buff;
};

/**
 *
 * @param {Uint8Array} bytes Bytes reprasentation
 * @returns {Dentry} Directory entry
 */
const deserializeDentry = (bytes) => {
  const filenameBytes = bytes.subarray(0, DENTRY_SIZE - N_SIZE);
  const filename = new TextDecoder().decode(
    filenameBytes.subarray(0, filenameBytes.indexOf(0))
  );
  const inoBytes = bytes.subarray(DENTRY_SIZE - N_SIZE);
  const ino = deserializeInt32(inoBytes);

  const dentry = new Dentry(filename, ino);
  return dentry;
};

/**
 *
 * @param {Dentry[]} dentries Directory entries
 * @return {Uint8Array} Bytes reprasentation
 */
const serializeDentries = (dentries) => {
  const buff = new Uint8Array(DENTRY_SIZE * dentries.length);

  dentries.forEach((dentry, index) => {
    const dentryBytes = serializeDentry(dentry);
    buff.set(dentryBytes, index * DENTRY_SIZE);
  });

  return buff;
};

/**
 *
 * @param {Uint8Array} bytes Bytes reprasentation
 * @returns {Dentry[]} Directory entreis
 */
const deserializeDentries = (bytes) => {
  const dentries = [];
  for (let offset = 0; offset < bytes.length; offset += DENTRY_SIZE) {
    const dentryBytes = bytes.subarray(offset, offset + DENTRY_SIZE);
    const dentry = deserializeDentry(dentryBytes);
    dentries.push(dentry);
  }
  return dentries;
};

/**
 *
 * @param {INode} inode File descriptor
 * @return {Uint8Array} Bytes reprasentation
 */
const serializeInode = (inode) => {
  const buff = new Uint8Array(INODE_SIZE);
  const inoBytes = serializeInt32(inode.ino);
  const typeBytes = serializeFileType(inode.type);
  const refsBytes = serializeInt16(inode.refs);
  const sizeBytes = serializeInt32(inode.size);
  const straightLinksBytes = inode.straightLinks.flatMap((link) => [
    ...serializeAddress(link),
  ]);
  const singleIndirectBytes = serializeAddress(inode.singleIndirect);
  const doubleIndirectBytes = serializeAddress(inode.doubleIndirect);

  buff.set(
    [
      ...inoBytes,
      ...typeBytes,
      ...refsBytes,
      ...sizeBytes,
      ...straightLinksBytes,
      ...singleIndirectBytes,
      ...doubleIndirectBytes,
    ],
    0
  );

  return buff;
};

/**
 *
 * @param {Uint8Array} bytes
 * @returns {INode} File descriptor
 */
const deserializeInode = (bytes) => {
  let offset = 0;
  const inoBytes = bytes.subarray(offset, INODE_INO_SIZE);
  offset += INODE_INO_SIZE;
  const typeBytes = bytes.subarray(offset, offset + INODE_TYPE_SIZE);
  offset += INODE_TYPE_SIZE;
  const refsBytes = bytes.subarray(offset, offset + INODE_REFS_SIZE);
  offset += INODE_REFS_SIZE;
  const sizeBytes = bytes.subarray(offset, offset + INODE_SIZE_SIZE);
  offset += INODE_SIZE_SIZE;
  const straightLinksBytes = bytes.subarray(
    offset,
    offset + ADDRESS_SIZE * INODE_STRAIGHT_LINKS_COUNT
  );
  offset += ADDRESS_SIZE * INODE_STRAIGHT_LINKS_COUNT;
  const singleIndirectBytes = bytes.subarray(offset, offset + ADDRESS_SIZE);
  const doubleIndirectBytes = bytes.subarray(offset, offset + ADDRESS_SIZE);

  const ino = deserializeInt32(inoBytes);
  const type = deserializeFileType(typeBytes);
  const refs = deserializeInt16(refsBytes);
  const size = deserializeInt32(sizeBytes);
  const straightLinks = [];
  for (let linkIndex = 0; linkIndex < INODE_STRAIGHT_LINKS_COUNT; linkIndex++) {
    const linkBytes = straightLinksBytes.subarray(
      linkIndex * ADDRESS_SIZE,
      (linkIndex + 1) * ADDRESS_SIZE
    );
    const link = deserializeAddress(linkBytes);
    straightLinks.push(link);
  }
  const singleIndirect = deserializeAddress(singleIndirectBytes);
  const doubleIndirect = deserializeAddress(doubleIndirectBytes);

  const inode = new INode(
    ino,
    type,
    size,
    refs,
    straightLinks,
    singleIndirect,
    doubleIndirect
  );
  return inode;
};

/**
 *
 * @param {FileType} type
 * @return {Uint8Array}
 */
const serializeFileType = (type) => {
  switch (type) {
    case FileType.REGULAR:
      return new Uint8Array([0, 1]);
    case FileType.DIRECTORY:
      return new Uint8Array([0, 2]);
    case FileType.SYMLINK:
      return new Uint8Array([0, 3]);
    case FileType.UNUSED:
      return new Uint8Array([0, 0]);
    default:
      return new Uint8Array([0, 0]);
  }
};

/**
 *
 * @param {Uint8Array} bytes
 * @returns {FileType}
 */
const deserializeFileType = (bytes) => {
  if (bytes[0] == 0 && bytes[1] == 1) {
    return FileType.REGULAR;
  } else if (bytes[0] == 0 && bytes[1] == 2) {
    return FileType.DIRECTORY;
  } else if (bytes[0] == 0 && bytes[1] == 3) {
    return FileType.SYMLINK;
  } else if (bytes[0] == 0 && bytes[1] == 0) {
    return FileType.UNUSED;
  } else {
    return FileType.UNUSED;
  }
};

/**
 *
 * @param {int} address
 * @returns {Uint8Array} Bytes reprasentation
 */
const serializeAddress = (address) => {
  return serializeInt32(address);
};

/**
 *
 * @param {Uint8Array} bytes Bytes reprasentation
 * @returns {int} Address
 */
const deserializeAddress = (bytes) => {
  return deserializeInt32(bytes);
};

/**
 *
 * @param {Uint8Array} bytes Bytes reprasentation
 * @returns {int[]} Addresses
 */
const deserializeAddresses = (bytes) => {
  const addresses = [];
  for (let offset = 0; offset < bytes.length; offset += ADDRESS_SIZE) {
    const addressBytes = bytes.subarray(
      offset * ADDRESS_SIZE,
      (offset + 1) * ADDRESS_SIZE
    );
    const address = deserializeAddress(addressBytes);
    addresses.push(address);
  }

  return addresses;
};

/**
 *
 * @param {int[]} addresses
 * @returns {Uint8Array} Bytes reprasentation
 */
const serializeAddresses = (addresses) => {
  const buff = Uint8Array(addresses.length * ADDRESS_SIZE);
  addresses.forEach((address, index) => {
    const addressBytes = serializeAddress(address);
    buff.set(addressBytes, index * ADDRESS_SIZE);
  });
  return buff;
};

/**
 *
 * @param {int} value
 * @returns {Uint8Array}
 */
const serializeInt32 = (value) => {
  return new Uint8Array([
    value >> 24,
    (value << 8) >> 24,
    (value << 16) >> 24,
    (value << 24) >> 24,
  ]);
};

/**
 *
 * @param {Uint8Array} bytes
 * @returns
 */
const deserializeInt32 = (bytes) => {
  return (bytes[0] << 24) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
};

/**
 *
 * @param {int} value
 */
const serializeInt16 = (value) => {
  return new Uint8Array([value >> 8, (value << 8) >> 8]);
};

/**
 *
 * @param {Uint8Array} bytes
 * @returns
 */
const deserializeInt16 = (bytes) => {
  return (bytes[0] << 8) + bytes[1];
};

export {
  // ----- Dentry -----
  serializeDentry,
  deserializeDentry,
  serializeDentries,
  deserializeDentries,
  // ------ INode -----
  serializeInode,
  deserializeInode,
  // ---- Address -----
  serializeAddress,
  deserializeAddress,
  serializeAddresses,
  deserializeAddresses,
  // ----- Int ----
  serializeInt32,
  deserializeInt32,
};
