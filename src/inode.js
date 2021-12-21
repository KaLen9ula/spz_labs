/**
 * Enum for file type.
 *
 * @readonly
 * @enum {symbol}
 *
 * @exports FileType
 */
const FileType = Object.freeze({
  UNUSED: Symbol("unused"),
  REGULAR: Symbol("regular"),
  DIRECTORY: Symbol("directory"),
  SYMLINK: Symbol("symlink"),
});

/**
 * @classdesc INode is a data structure in a Unix-style file system that
 * describes a file-system object such as a file or a directory
 *
 * @exports INode
 */
class INode {
  /**
   * Index node
   *
   * @constructor
   * @param {int} ino Unique inode number. Each file in a filesystem has a unique inode number.
   * @param {FileType} type Type of file, such as regular, directory, symlink
   * @param {int} size File size
   * @param {int} refs Hard links count
   * @param {int[]} straightLinks Straight links to file blocks
   * @param {int} singleIndirect Addess of block that containes next straight links
   * @param {int} doubleIndirect Address of block that containes addresses of signle indirect blocks
   */
  constructor(
    ino,
    type,
    size,
    refs,
    straightLinks,
    singleIndirect,
    doubleIndirect
  ) {
    this.ino = ino;
    this.type = type;
    this.size = size;
    this.refs = refs;
    this.straightLinks = straightLinks;
    this.singleIndirect = singleIndirect;
    this.doubleIndirect = doubleIndirect;
  }
}

export default INode;
export { FileType };
