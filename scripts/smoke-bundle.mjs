import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const requiredManifestKeys = [
  "id",
  "name",
  "version",
  "minAppVersion",
  "description",
  "author",
  "authorUrl",
  "isDesktopOnly",
];

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
for (const key of requiredManifestKeys) {
  assert.ok(Object.hasOwn(manifest, key), `manifest.json is missing ${key}`);
}
assert.equal(manifest.id, "timepoint");
assert.equal(manifest.isDesktopOnly, true);

const bundle = await readFile("main.js", "utf8");
assert.ok(bundle.length > 1_000, "main.js is unexpectedly small");
assert.match(bundle, /require\("obsidian"\)/u);
for (const forbidden of [
  'require("electron")',
  'require("node:fs")',
  'require("fs")',
  'require("child_process")',
  "OPENAI_API_KEY",
  "BEGIN PRIVATE KEY",
]) {
  assert.ok(!bundle.includes(forbidden), `Runtime bundle contains forbidden token: ${forbidden}`);
}

class Component {
  addChild() {}
  register() {}
  registerEvent() {}
}

class Plugin extends Component {}
class ItemView extends Component {}
class MarkdownRenderChild extends Component {}
class Modal {}
class PluginSettingTab {}
class Setting {}
class Menu {}
class Notice {}
class TFile {}
class TFolder {}
class MarkdownRenderer {}

const obsidianMock = {
  App: class App {},
  Component,
  Plugin,
  ItemView,
  MarkdownRenderChild,
  Modal,
  PluginSettingTab,
  Setting,
  Menu,
  Notice,
  TFile,
  TFolder,
  MarkdownRenderer,
  normalizePath: (value) => value.replaceAll("//", "/"),
  setIcon: () => {},
};

const moduleRecord = { exports: {} };
vm.runInNewContext(
  bundle,
  {
    module: moduleRecord,
    exports: moduleRecord.exports,
    require: (id) => {
      assert.equal(id, "obsidian", `Unexpected runtime dependency ${id}`);
      return obsidianMock;
    },
    console,
    globalThis,
    Intl,
    Date,
    Map,
    Set,
    Promise,
    RegExp,
    Error,
    RangeError,
    Uint32Array,
    Math,
    JSON,
  },
  { filename: "main.js" },
);

assert.equal(typeof moduleRecord.exports.default, "function", "Bundle has no default plugin class");
console.log("PASS: manifest, dependency boundary, secret scan, and bundle evaluation");
