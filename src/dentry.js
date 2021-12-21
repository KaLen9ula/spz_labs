/**
 * @classdesc Directory entry
 * link file name and inode
 *
 * @exports Dentry
 */
class Dentry {
  /**
   * Directory entry
   * @constructor
   * @param {string} fileName File name
   * @param {int} ino Unique inode number
   */
  constructor(fileName, ino) {
    this.fileName = fileName;
    this.ino = ino;
  }
}

export default Dentry;
