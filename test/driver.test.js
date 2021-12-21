"use strict";

import { NAN_BLOCK_ADDRESS } from "../src/constants.js";
import Dentry from "../src/dentry.js";
import Device from "../src/device.js";
import Driver from "../src/driver.js";
import { FileAlreadyExist, InvalidPath } from "../src/exceptions.js";
import { FileType } from "../src/inode.js";
import {
  BLOCK_SIZE,
  BLOCK_COUNT,
  INODE_STRAIGHT_LINKS_COUNT,
  DENTRY_SIZE,
  MAX_SYMLINK_DEPTH,
} from "../src/settings.js";

const device = new Device(BLOCK_SIZE, BLOCK_COUNT);
const driver = new Driver(device);

test("after mkfs must be created root", () => {
  const n = 10;

  driver.mkfs(n);

  const _n = driver._getN();
  const root = driver.getDescriptor(0);
  expect(_n).toBe(n);
  expect(root.ino).toBe(0);
  expect(root.type).toBe(FileType.DIRECTORY);
  expect(root.refs).toBe(2);
  expect(root.size).toBe(DENTRY_SIZE * 2);
  expect(root.straightLinks).toEqual(
    expect.arrayContaining(new Array(INODE_STRAIGHT_LINKS_COUNT).fill(0))
  );
  expect(root.singleIndirect).toBe(NAN_BLOCK_ADDRESS);
});

test("create regular file", () => {
  const filename = "file";
  const filePath = `/${filename}`;
  const n = 10;

  driver.mkfs(n);
  driver.create(filePath);

  const dentries = driver.readDirectory("/");

  expect(dentries.length).toBe(3);
  expect(dentries[2].fileName).toBe(filename);
});

test("create multiple regular file", () => {
  const filename = "file";
  const fileCount = 10;
  const n = fileCount + 1;
  driver.mkfs(n);

  for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
    const filePath = `/${filename}${fileIndex}`;
    driver.create(filePath);
  }

  const dentries = driver.readDirectory("/");
  expect(dentries.length).toBe(fileCount + 2);
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
    expect(dentries[fileIndex + 2].fileName).toBe(`${filename}${fileIndex}`);
    expect(dentries[fileIndex + 2].ino).toBe(fileIndex + 1);
  }
});

test("make link", () => {
  const filename = "file";
  const linkedFilename = "link";
  const n = 10;
  driver.mkfs(n);

  const filePath = `/${filename}`;
  const linkPath = `/${linkedFilename}`;
  driver.create(filePath);
  driver.link(filePath, linkPath);

  const dentries = driver.readDirectory("/");
  const expectedDentries = [
    new Dentry(".", 0),
    new Dentry("..", 0),
    new Dentry(filename, 1),
    new Dentry(linkedFilename, 1),
  ];
  const inode = driver.getDescriptor(1);
  expect(dentries).toEqual(expectedDentries);
  expect(inode.refs).toBe(2);
});

test("make unlink", () => {
  const filename = "file";
  const linkedFilename = "link";
  const n = 10;
  driver.mkfs(n);
  const filePath = `/${filename}`;
  const linkPath = `/${linkedFilename}`;
  driver.create(filePath);
  driver.link(filePath, linkPath);

  driver.unlink(linkPath);

  const dentries = driver.readDirectory("/");
  const expectedDentries = [
    new Dentry(".", 0),
    new Dentry("..", 0),
    new Dentry(filename, 1),
  ];
  const inode = driver.getDescriptor(1);
  expect(dentries).toEqual(expectedDentries);
  expect(inode.refs).toBe(1);
});

test("multiple link", () => {
  const filename = "file";
  const filePath = `/${filename}`;
  const linkedFilename = "link";
  const linkCount = 10;
  const n = linkCount + 2;

  driver.mkfs(n);
  driver.create(filePath);
  for (let linkIndex = 0; linkIndex < linkCount; linkIndex++) {
    const linkPath = `/${linkedFilename}${linkIndex}`;
    driver.link(filePath, linkPath);
  }

  const dentries = driver.readDirectory("/");
  const expectedDentries = [];
  expectedDentries.push(new Dentry(".", 0));
  expectedDentries.push(new Dentry("..", 0));
  expectedDentries.push(new Dentry(filename, 1));
  for (let linkIndex = 0; linkIndex < linkCount; linkIndex++) {
    expectedDentries.push(new Dentry(`${linkedFilename}${linkIndex}`, 1));
  }

  const inode = driver.getDescriptor(1);
  expect(dentries).toEqual(expectedDentries);
  expect(inode.refs).toBe(linkCount + 1);
});

test("simple write to file", () => {
  const filename = "file";
  const filePath = `/${filename}`;
  const n = 10;
  const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  driver.mkfs(n);
  driver.create(filePath);

  driver.truncate(filePath, 100);
  const file = driver.open(filePath);
  driver.write(file, 10, testData);
  const data = driver.read(file, 0, 50);

  const buff = new Uint8Array(50);
  buff.set(testData, 10);
  expect(data).toEqual(buff);
});

test("decrease size of file and after increase must set erase bytes to zero", () => {
  const filename = "file";
  const filePath = `/${filename}`;
  const n = 10;
  const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  driver.mkfs(n);
  driver.create(filePath);
  driver.truncate(filePath, 20);
  const file = driver.open(filePath);
  driver.write(file, 10, testData);
  driver.truncate(filePath, 15);
  driver.truncate(filePath, 30);
  const data = driver.read(file, 0, 30);

  const buff = new Uint8Array(30);
  buff.set(testData.slice(0, 5), 10);
  expect(data).toEqual(buff);
});

test("mkdir", () => {
  const n = 10;
  const dirName1 = "dir1";
  const dirName2 = "dir2";
  driver.mkfs(n);
  driver.mkdir(`${dirName1}`);
  driver.mkdir(`/${dirName1}/${dirName2}`);

  const dentries = driver.readDirectory(`/${dirName1}`);
  const expectedDentries = [
    new Dentry(".", 1),
    new Dentry("..", 0),
    new Dentry("dir2", 2),
  ];
  expect(dentries).toEqual(expectedDentries);
});

test("rmdir", () => {
  const n = 10;
  const dirName1 = "dir1";
  const dirName2 = "dir2";
  driver.mkfs(n);
  driver.mkdir(`${dirName1}`);
  driver.mkdir(`/${dirName1}/${dirName2}`);
  driver.rmdir(`/${dirName1}/${dirName2}`);

  const dentries = driver.readDirectory(`/${dirName1}`);
  const expectedDentries = [new Dentry(".", 1), new Dentry("..", 0)];
  expect(dentries).toEqual(expectedDentries);
});

test("symlink", () => {
  const n = 10;
  const dirName1 = "dir1";
  const dirName2 = "dir2";
  const symlink = "symlink";
  driver.mkfs(n);
  driver.mkdir(`${dirName1}`);
  driver.mkdir(`/${dirName1}/${dirName2}`);
  driver.symlink(`/${dirName1}/${dirName2}/${symlink}`, "../..");

  const dentries = driver.readDirectory(
    `${dirName1}/${dirName2}/${symlink}/${dirName1}/${dirName2}`
  );
  const expectedDentries = [
    new Dentry(".", 2),
    new Dentry("..", 1),
    new Dentry(symlink, 3),
  ];
  expect(dentries).toEqual(expectedDentries);
});

test("lookup file not found", () => {
  const n = 10;
  driver.mkfs(n);
  const l = () => driver.lookUp("/notFoundFile");
  expect(l).toThrow(InvalidPath);
});

test("symlink max depth overlapce", () => {
  const n = 10;
  const symlink = "symlink";
  driver.mkfs(n);
  driver.symlink(`/${symlink}`, ".");
  const l = () =>
    driver.lookUp(
      `/${symlink}/${symlink}/${symlink}/${symlink}/${symlink}/${symlink}`
    );
  console.log("TEST");
  expect(l).toThrow("Symlink max depth overlapce");
});

test("create file in not existen directory", () => {
  const filename = "file";
  const filePath = `/notExistenDirectory/${filename}`;
  const n = 10;

  driver.mkfs(n);
  const c = () => driver.create(filePath);
  expect(c).toThrow(InvalidPath);
});

test("create file in other file", () => {
  const filename1 = "file1";
  const filename2 = "file2";
  const filePath1 = `/${filename1}`;
  const filePath2 = `/${filename1}/${filename2}`;
  const n = 10;

  driver.mkfs(n);
  driver.create(filePath1);
  const c = () => driver.create(filePath2);
  expect(c).toThrow(InvalidPath);
});

test("make link to directory", () => {
  const dirname = "dir";
  const linkedFilename = "link";
  const n = 10;
  driver.mkfs(n);

  const dirPath = `/${dirname}`;
  const linkPath = `/${linkedFilename}`;
  driver.mkdir(dirPath);
  const l = () => driver.link(dirPath, linkPath);

  expect(l).toThrow(InvalidPath);
});

test("make dir that already exist", () => {
  const dirname = "dir";
  const n = 10;
  driver.mkfs(n);

  const dirPath = `/${dirname}`;
  driver.mkdir(dirPath);
  const l = () => driver.mkdir(dirPath);

  expect(l).toThrow(FileAlreadyExist);
});
