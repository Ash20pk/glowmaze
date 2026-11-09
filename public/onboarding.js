// "How to play" screens shown before the first game (and on H). Enter / → next, ← back, Esc skips.

import { HUNTERS } from "./shared.js";

const ROLES = {
  rook: "The bruiser. Comes straight at you.",
  vex: "The interceptor. Cuts you off ahead.",
  moth: "The guard. Camps the sparks you need.",
  grim: "The herder. Pushes you toward the others.",
  pip: "The trickster. Fills whatever gap is left.",
};

const POWER_BLURB = {
  wall: "drops a wall that seals a corridor for 6s",
  blink: "teleports ahead of you to cut you off",
  flare: "lights up a wide area; inside it, you can't hide",
  sludge: "coats a corridor in goo that halves your speed",
  snare: "hides a trap that freezes and reveals you",
};

const hex = (color, size = 26) =>
  `<span class="g-hex" style="--c:${color};width:${size}px;height:${size}px"><i></i></span>`;

const STEPS = [
  {
    kicker: "1 / 5 · the goal",
    title: "YOU ARE THE ORB",
    art: `<div class="g-art g-goal"><span class="g-orb"></span><span class="g-trail">${'<i class="g-spark"></i>'.repeat(7)}</span></div>`,
    body: `
      <p>Glide through the maze and collect <b class="spark">every spark</b> to clear the board.</p>
      <p>Each new board makes the hunters a little faster. You have <b class="hot">three lives</b>.</p>`,
  },
  {
    kicker: "2 / 5 · the hunters",
    title: "FIVE HUNTERS, FIVE POWERS",
    art: `<ul class="g-hunters">${HUNTERS.map(
      (h) => `<li>${hex(h.color)}<b style="color:${h.color}">${h.name}</b><span>${ROLES[h.id]}</span><span class="g-pw" style="--c:${h.color}"><b>${h.power.name}</b>: ${POWER_BLURB[h.power.id]}</span></li>`
    ).join("")}</ul>`,
    body: `<p>Nothing here is scripted. Every move each hunter makes is decided <b class="ok">live by an AI model on Wafer</b>, several times a second. The AI decides where each one goes, when to use its power, and how to combine powers with the team. A power <b>flashes for half a second</b> before it lands, so watch for the warning.</p>`,
  },
  {
    kicker: "3 / 5 · the chase",
    title: "EVERY MOVE GIVES YOU AWAY",
    art: `<ul class="g-legend">
      <li><span class="g-ping"></span><span><b>Ping</b>: each step broadcasts where you are to every hunter</span></li>
      <li><span class="g-chaser"></span><span><b>Chaser</b>: the nearest hunter. Every ping wakes it to re-plan, and it radios orders 📡 sending the others to cover your escapes</span></li>
      <li><span class="g-sight"></span><span><b>Sight line</b>: a hunter can see you down a straight corridor</span></li>
      <li><span class="g-q">?</span><span><b>Last known</b>: where they last placed you</span></li>
    </ul>`,
    body: `
      <p>While you move you're <b class="hot">PINGING</b>, and the team always knows where you are. <b class="ok">Stand still</b> and you go <b class="ok">SILENT</b>: then they can only find you by sight, and have to search.</p>
      <p>But sparks don't collect themselves. Move in bursts, break line of sight, and go quiet when they close in.</p>`,
  },
  {
    kicker: "4 / 5 · controls",
    title: "CONTROLS",
    art: `<ul class="g-keys">
      <li><span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> or <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span>Move</span></li>
      <li><span><kbd class="wide">SPACE</kbd></span><span>Pulse: stuns hunters within 5 tiles for 3 seconds and <b>breaks their walls, sludge and snares</b> nearby. Grab the <b class="pulse">purple orbs</b> for more</span></li>
      <li><span><kbd>P</kbd></span><span>Pause</span></li>
      <li><span><kbd>F</kbd></span><span>Fullscreen</span></li>
      <li><span><kbd>T</kbd></span><span>Show or hide the hunters' plans</span></li>
      <li><span><kbd>H</kbd></span><span>This guide</span></li>
    </ul>`,
    body: "",
  },
  {
    kicker: "5 / 5 · the experiment",
    title: "THE LAG SWITCH",
    art: `<div class="g-art g-lag"><div class="g-lagbox live"><small>INFERENCE</small><b>LIVE</b><em>~0.8s per decision</em></div><kbd class="big">L</kbd><div class="g-lagbox slow"><small>INFERENCE</small><b>+2s LAG</b><em>~2.8s per decision</em></div></div>`,
    body: `
      <p>Press <kbd>L</kbd> to add 2 seconds to every AI decision. Same AI, same prompts. It just thinks late.</p>
      <p>Watch the hunters chase where you <i>used</i> to be. Press <kbd>L</kbd> again and they snap back. The panel on the right shows how fast Wafer is answering, live.</p>`,
  },
];

export function openGuide(onDone) {
  let step = 0;
  const el = document.createElement("div");
  el.className = "guide";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  document.body.append(el);

  const render = () => {
    const s = STEPS[step];
    const last = step === STEPS.length - 1;
    el.innerHTML = `
      <div class="g-card">
        <p class="g-kicker">${s.kicker}</p>
        <h2>${s.title}</h2>
        ${s.art}
        <div class="g-body">${s.body}</div>
        <div class="g-nav">
          <button class="g-skip" data-act="skip">${last ? "" : "Skip intro (Esc)"}</button>
          <div class="g-dots">${STEPS.map((_, i) => `<i class="${i === step ? "on" : ""}"></i>`).join("")}</div>
          <div class="g-btns">
            ${step ? `<button data-act="back">Back</button>` : ""}
            <button class="g-next" data-act="next">${last ? "START PLAYING ▶" : "Next ▶"}</button>
          </div>
        </div>
      </div>`;
    el.querySelector(".g-next").focus();
  };

  const close = () => {
    removeEventListener("keydown", onKey, true);
    el.remove();
    onDone();
  };
  const go = (d) => {
    const n = step + d;
    if (n >= STEPS.length) return close();
    if (n >= 0) (step = n), render();
  };
  const onKey = (e) => {
    if (["Enter", "ArrowRight", " "].includes(e.key)) go(1);
    else if (["ArrowLeft", "Backspace"].includes(e.key)) go(-1);
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  el.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "next") go(1);
    else if (act === "back") go(-1);
    else if (act === "skip" && step < STEPS.length - 1) close();
  });
  addEventListener("keydown", onKey, true);
  render();
}
