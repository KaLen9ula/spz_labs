import { BLOCK_SIZE } from "./settings";

/**
 * @classdesc Block I/O device
 *
 * @exports Device
 */
class Device {
  /**
   * Block device
   * @constructor
   * @description In memory block device
   *
   * @param {int} blockSize
   * @param {int} blockCount
   */
  constructor(blockSize, blockCount) {
    this.blockSize = blockSize;
    this.blockCount = blockCount;
    this.memory = new Uint8Array(blockCount * blockSize);
  }

  /**
   *
   * @param {int} blockAddress
   *
   * @return {Uint8Array}
   */
  readBlock(blockAddress) {
    return this.memory.subarray(
      blockAddress * this.blockSize,
      (blockAddress + 1) * this.blockSize
    );
  }

  /**
   *
   * @param {int} blockAddress
   * @param {Uint8Array} block
   */
  writeBlock(blockAddress, block) {
    this.memory.set(block, blockAddress * this.blockSize);
  }
}

export default Device;
