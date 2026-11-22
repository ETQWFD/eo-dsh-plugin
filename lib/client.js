window.__ModuleLoader__.load({id:`dsh-eo-assistant`,factory:require=>{var module={exports:{}};var exports=module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.js
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/section.js
var import_react = __toESM(require("react"), 1);
var h = import_react.default.createElement;
var { useEffect, useRef, useState } = import_react.default;
var API = "/eo/api";
var C = {
  text: "var(--dsh-text-primary, #1f2328)",
  muted: "var(--dsh-text-secondary, #656d76)",
  bg: "var(--dsh-bg-secondary, #f6f8fa)",
  border: "var(--dsh-border-default, #d0d7de)",
  accent: "var(--dsh-accent, #0969da)",
  success: "#1a7f37",
  danger: "#cf222e",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
};
function card(children) {
  return h("div", {
    style: {
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: 16,
      marginBottom: 14,
      background: "var(--dsh-bg-primary, #ffffff)",
      color: C.text,
      fontSize: 14
    }
  }, children);
}
function label(text) {
  return h("div", { style: { fontWeight: 600, fontSize: 13, marginBottom: 8 } }, text);
}
function button(text, onClick, options = {}) {
  return h("button", {
    type: "button",
    onClick,
    disabled: options.disabled,
    style: {
      appearance: "none",
      border: `1px solid ${options.primary ? C.accent : C.border}`,
      background: options.primary ? C.accent : "transparent",
      color: options.primary ? "#ffffff" : C.text,
      borderRadius: 6,
      padding: "6px 12px",
      fontSize: 13,
      cursor: options.disabled ? "not-allowed" : "pointer",
      opacity: options.disabled ? 0.55 : 1,
      marginRight: 8
    }
  }, text);
}
function dot(online) {
  return h("span", {
    style: {
      display: "inline-block",
      width: 8,
      height: 8,
      borderRadius: 4,
      background: online ? C.success : C.muted,
      marginRight: 6,
      verticalAlign: "middle"
    }
  });
}
function badge(text, tone) {
  const colors = { ok: C.success, warn: "#9a6700", bad: C.danger, neutral: C.muted };
  return h("span", {
    style: {
      display: "inline-block",
      border: `1px solid ${colors[tone] || C.muted}`,
      color: colors[tone] || C.muted,
      borderRadius: 999,
      padding: "2px 8px",
      fontSize: 12,
      marginRight: 8
    }
  }, text);
}
async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text.slice(0, 200) };
  }
}
function EoConnectSection() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [nameReady, setNameReady] = useState(false);
  const alive = useRef(true);
  const refresh = async () => {
    try {
      const response = await fetch(`${API}/state`, { cache: "no-store", credentials: "same-origin" });
      const json = await readJson(response);
      if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
      if (!alive.current) return;
      setData(json);
      setError("");
      if (!nameReady) {
        setName(json.assistantName || "");
        setNameReady(true);
      }
    } catch (err) {
      if (!alive.current) return;
      setError(err && err.message ? err.message : String(err));
    }
  };
  useEffect(() => {
    alive.current = true;
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);
  const post = async (path, body) => {
    if (!data?.token) {
      setError("\u8BBE\u7F6E\u63A5\u53E3\u5C1A\u672A\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      return null;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}${path}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-eo-token": data.token },
        body: JSON.stringify(body || {})
      });
      const json = await readJson(response);
      if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
      await refresh();
      return json;
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };
  if (error && !data) {
    return card([
      label("EO\u52A9\u624B\u8FDE\u63A5"),
      h("div", { style: { color: C.danger, marginBottom: 8 } }, "\u65E0\u6CD5\u8BBF\u95EE\u63D2\u4EF6\u8BBE\u7F6E\u63A5\u53E3"),
      h("div", { style: { color: C.muted, fontSize: 13, lineHeight: 1.6 } }, error),
      h(
        "div",
        { style: { color: C.muted, fontSize: 13, lineHeight: 1.6, marginTop: 8 } },
        "\u8BF7\u786E\u8BA4\uFF1A1) \u63D2\u4EF6\u5728 DSH \u4E2D\u5DF2\u542F\u7528\uFF1B2) \u5F53\u524D\u662F DSH Web \u8BBE\u7F6E\u9875\uFF1B3) Desktop \u7AEF\u5DF2\u66F4\u65B0\u5230\u5305\u542B\u672C\u63D2\u4EF6\u7684\u7248\u672C\u3002"
      )
    ]);
  }
  if (!data) return card([label("EO\u52A9\u624B\u8FDE\u63A5"), h("div", { style: { color: C.muted } }, "\u6B63\u5728\u8BFB\u53D6\u8FDE\u63A5\u72B6\u6001\u2026")]);
  const bind = data.bind;
  const remain = bind ? Math.max(0, Math.ceil((bind.expiresAt - Date.now()) / 1e3)) : 0;
  const conversationLength = data.conversations.length;
  const statusRow = h("div", { style: { marginBottom: 12 } }, [
    badge(data.connected ? "relay \u5728\u7EBF" : "relay \u79BB\u7EBF", data.connected ? "ok" : "bad"),
    badge(data.relayKind === "embedded" ? "\u5185\u7F6E relay" : "\u5916\u90E8 relay", "neutral"),
    badge(data.model || "\u672A\u914D\u7F6E\u6A21\u578B", data.model ? "neutral" : "warn"),
    badge(conversationLength ? `${conversationLength} \u4E2A\u52A9\u624B` : "\u672A\u7ED1\u5B9A", conversationLength ? "ok" : "neutral"),
    h("span", { style: { color: C.muted, fontSize: 12, fontFamily: C.mono } }, data.deviceId)
  ]);
  const identityCard = card([
    label("\u52A9\u624B\u4FE1\u606F"),
    h("div", { style: { display: "flex", alignItems: "center", gap: 14, marginBottom: 12 } }, [
      data.hasIcon ? h("img", {
        src: `${API}/icon?v=${data.iconVersion}`,
        alt: "\u52A9\u624B\u56FE\u6807",
        style: { width: 48, height: 48, borderRadius: 10, objectFit: "cover", border: `1px solid ${C.border}` }
      }) : h("div", {
        style: {
          width: 48,
          height: 48,
          borderRadius: 10,
          background: C.bg,
          border: `1px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 18,
          color: C.muted
        }
      }, "EO"),
      h("div", { style: { flex: 1 } }, [
        h("div", { style: { color: C.muted, fontSize: 12, marginBottom: 4 } }, "\u8FDE\u63A5\u52A9\u624B\u540D\u79F0"),
        h("input", {
          value: name,
          maxLength: 32,
          onChange: (event) => setName(event.target.value),
          style: {
            width: "100%",
            boxSizing: "border-box",
            padding: "6px 10px",
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            background: "var(--dsh-bg-primary, #ffffff)",
            color: C.text,
            fontSize: 13
          }
        })
      ])
    ]),
    h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 } }, [
      button("\u4FDD\u5B58\u540D\u79F0", () => post("/settings", { assistantName: name }), {
        primary: true,
        disabled: busy || !name.trim() || name.trim() === data.assistantName
      }),
      h("label", {
        style: {
          display: "inline-block",
          padding: "5px 10px",
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 13,
          color: C.text
        }
      }, [
        "\u9009\u62E9\u672C\u5730\u56FE\u6807",
        h("input", {
          type: "file",
          accept: "image/png,image/jpeg",
          style: { display: "none" },
          onChange: (event) => {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            if (file.size > 512 * 1024) {
              setError("\u56FE\u6807\u4E0D\u80FD\u8D85\u8FC7 512KB");
              return;
            }
            const reader = new FileReader();
            reader.onload = () => {
              post("/icon", { dataUrl: String(reader.result) });
            };
            reader.onerror = () => setError("\u8BFB\u53D6\u672C\u5730\u56FE\u6807\u5931\u8D25");
            reader.readAsDataURL(file);
          }
        })
      ]),
      h("span", { style: { color: C.muted, fontSize: 12 } }, "PNG/JPEG\uFF0C\u2264512KB")
    ])
  ]);
  let bindBody;
  if (!data.relayUrl) {
    bindBody = h("div", { style: { color: C.muted, lineHeight: 1.7 } }, [
      h(
        "div",
        { style: { color: data.relayError ? C.danger : C.muted, marginBottom: 10 } },
        data.relayError || "\u6B63\u5728\u542F\u52A8\u5185\u7F6E relay\u2026\u7A0D\u7B49\u51E0\u79D2\u540E\u5237\u65B0\u3002"
      ),
      button("\u91CD\u8BD5", () => post("/bind/new"), { disabled: busy })
    ]);
  } else if (!bind) {
    bindBody = h("div", null, [
      h(
        "div",
        { style: { color: C.muted, marginBottom: 10, lineHeight: 1.7 } },
        "\u70B9\u51FB\u751F\u6210\u4E8C\u7EF4\u7801\uFF0C\u7528\u624B\u673A EO\u52A9\u624B \u53F3\u4E0A\u89D2\u201C\u626B\u4E00\u626B\u201D\u7ED1\u5B9A\u8FD9\u53F0\u7535\u8111\u3002\u624B\u673A\u548C\u7535\u8111\u5728\u540C\u4E00 Wi-Fi \u4E0B\u5373\u53EF\uFF0C\u65E0\u9700\u586B\u5199 relay \u5730\u5740\uFF1B\u4E8C\u7EF4\u7801 120 \u79D2\u5185\u6709\u6548\u3002\u624B\u673A\u6D88\u606F\u4F1A\u8FDB\u5165 DSH \u4F1A\u8BDD\uFF1BAI \u56DE\u590D\u4F9D\u8D56\u5DE6\u4FA7 Models \u91CC\u5DF2\u914D\u7F6E\u7684\u6A21\u578B\u4E0E API Key\u3002"
      ),
      button(busy ? "\u751F\u6210\u4E2D\u2026" : "\u751F\u6210\u4E8C\u7EF4\u7801", () => post("/bind/new"), { primary: true, disabled: busy })
    ]);
  } else if (bind.status === "confirmed") {
    bindBody = h("div", null, [
      h("div", { style: { color: C.success, fontWeight: 600, marginBottom: 8 } }, "\u5DF2\u8FDE\u63A5"),
      h(
        "div",
        { style: { color: C.muted, lineHeight: 1.7, marginBottom: 10 } },
        "\u624B\u673A\u7AEF\u5DF2\u7ED1\u5B9A\u3002\u73B0\u5728\u53EF\u4EE5\u5728\u624B\u673A\u4E0A\u5411\u8BE5\u52A9\u624B\u53D1\u9001\u6D88\u606F\uFF0C\u6D88\u606F\u4F1A\u8FDB\u5165\u5BF9\u5E94\u7684 DSH \u4F1A\u8BDD\u5E76\u5F52\u6863\u5230 eo/ \u76EE\u5F55\u3002"
      ),
      button("\u518D\u7ED1\u5B9A\u4E00\u53F0\u624B\u673A", () => post("/bind/new"), { primary: true, disabled: busy })
    ]);
  } else {
    const expired = remain <= 0;
    bindBody = h("div", { style: { textAlign: "center" } }, [
      expired ? h("div", { style: { color: C.danger, padding: "40px 0" } }, "\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210") : h("img", {
        src: bind.qrDataUrl,
        alt: "EO\u52A9\u624B\u7ED1\u5B9A\u4E8C\u7EF4\u7801",
        width: 240,
        height: 240,
        style: { display: "block", margin: "0 auto 10px", background: "#fff", padding: 8, borderRadius: 8 }
      }),
      h(
        "div",
        { style: { color: C.muted, fontSize: 12, marginBottom: 10 } },
        expired ? "" : `\u6709\u6548\u671F\u5269\u4F59 ${remain} \u79D2`
      ),
      bind.status === "claimed" && bind.code ? h("div", { style: { margin: "10px 0 14px" } }, [
        h("div", { style: { color: C.muted, fontSize: 12, marginBottom: 6 } }, "\u8BF7\u5728\u624B\u673A\u4E0A\u8F93\u5165\u4EE5\u4E0B 6 \u4F4D\u786E\u8BA4\u7801"),
        h("div", {
          style: {
            fontFamily: C.mono,
            fontSize: 28,
            letterSpacing: 6,
            fontWeight: 700,
            color: C.text
          }
        }, String(bind.code))
      ]) : null,
      h("div", null, [
        button(expired ? "\u91CD\u65B0\u751F\u6210" : "\u5237\u65B0\u4E8C\u7EF4\u7801", () => post("/bind/new"), { primary: true, disabled: busy }),
        button("\u53D6\u6D88", () => post("/bind/cancel"), { disabled: busy })
      ])
    ]);
  }
  const bindCard = card([label("\u626B\u7801\u7ED1\u5B9A"), statusRow, bindBody]);
  const conversations = Array.isArray(data.conversations) ? data.conversations : [];
  const conversationRows = conversations.length ? conversations.map((conv) => h("div", {
    key: conv.convId,
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "8px 0",
      borderTop: `1px solid ${C.border}`
    }
  }, [
    h("div", null, [
      h("div", { style: { fontWeight: 600 } }, [dot(conv.online), conv.title || "EO\u52A9\u624B"]),
      h(
        "div",
        { style: { color: C.muted, fontSize: 12, fontFamily: C.mono } },
        `${conv.convId} \xB7 ${conv.peerDeviceId}`
      )
    ]),
    button("\u79FB\u9664\u7ED1\u5B9A", () => post("/unbind", { convId: conv.convId }), { disabled: busy })
  ])) : [h("div", { style: { color: C.muted } }, "\u8FD8\u6CA1\u6709\u7ED1\u5B9A\u624B\u673A\u3002")];
  const conversationsCard = card([label("\u5DF2\u8FDE\u63A5\u7684\u52A9\u624B"), ...conversationRows]);
  const diagnostics = h("details", { style: { marginTop: 4, color: C.muted, fontSize: 12 } }, [
    h("summary", { style: { cursor: "pointer" } }, "\u8BCA\u65AD\u4FE1\u606F"),
    h("div", { style: { marginTop: 8, fontFamily: C.mono, lineHeight: 1.7, wordBreak: "break-all" } }, [
      h("div", null, `relay: ${data.relayUrl || "(\u542F\u52A8\u4E2D)"}`),
      h("div", null, `relay kind: ${data.relayKind || "embedded"}`),
      h("div", null, `connected: ${String(data.connected)}`),
      h("div", null, `error: ${data.relayError || "(\u65E0)"}`),
      h("div", null, `device: ${data.deviceId}`)
    ])
  ]);
  return h("div", null, [
    error ? h("div", {
      style: {
        border: `1px solid ${C.danger}`,
        color: C.danger,
        borderRadius: 8,
        padding: "8px 12px",
        marginBottom: 12,
        fontSize: 13
      }
    }, error) : null,
    identityCard,
    bindCard,
    conversationsCard,
    diagnostics
  ]);
}

// src/client/index.js
var inject = ["slots"];
function apply(ctx) {
  ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "eo-assistant",
    order: 40,
    label: () => "EO\u52A9\u624B\u8FDE\u63A5"
  }, EoConnectSection)), "eo: settings section");
}

return module.exports}});
