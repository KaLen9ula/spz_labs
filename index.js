import Device from "./src/device.js";
import Driver from "./src/driver.js";

import {
  BLOCK_SIZE,
  BLOCK_COUNT,
  INODE_STRAIGHT_LINKS_COUNT,
  DENTRY_SIZE,
  MAX_SYMLINK_DEPTH,
} from "./src/settings.js";

const device = new Device(BLOCK_SIZE, BLOCK_COUNT);
const driver = new Driver(device);

const n = 10;
driver.mkfs(n);

function execute(f, index) {
  console.log(`Command #${index}: `, f.toString());
  try {
    return f();
  } catch (e) {
    console.log("Error: " + e);
    return null;
  } finally {
    console.log("==========\n");
  }
}

const commands = [
  () => console.log(driver.pwd()),
  () => driver.mkdir("/a"),
  () => driver.mkdir("/a/b"),
  () => driver.mkdir("/a/c"),
  () => driver.mkdir("/a/c/d"),
  () => driver.mkdir("/a/c/d/e"),
  () => driver.symlink("/a/c/d/l3/d", "/a/b/s2"),
  () => driver.symlink("/a/c", "/a/c/d/l3"),
  () => console.log("Directory '/a':\n", driver.readDirectory("/a")),
  () => console.log("Directory '/a/b':\n", driver.readDirectory("/a/b")),
  () => console.log("Directory '/a/c/d':\n", driver.readDirectory("/a/c/d")),
  () => console.log(driver.cd("/a/b/s2/e")),
  () => console.log(driver.pwd()),
];

commands.forEach((command, index) => {
  execute(command, index + 1);
});
