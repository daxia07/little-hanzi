// Original editable v6-derived review candidate. Accepted raster remains the fallback.
const asset = new URL('./mascot-layered.svg', import.meta.url);
const fallback = new URL('./capybara-welcome-v6.png', import.meta.url);
const performances = {
  focused: {
    duration: 1200,
    left: [0, 12, 0],
    right: [0, 7, 0],
    head: [0, 2, 0],
    brows: [0, 0, 0],
  },
  aha: {
    duration: 1450,
    left: [0, 16, 0],
    right: [0, -22, 0],
    head: [0, -2, 0],
    brows: [0, -3, 0],
  },
  delighted: {
    duration: 1500,
    left: [0, 16, 0],
    right: [0, -18, 0],
    head: [0, -1, 0],
    brows: [0, -3, 0],
  },
  welcome: {
    duration: 1400,
    left: [0, -5, 0],
    right: [0, -32, -18, -32, 0],
    head: [0, -2, 0],
    brows: [0, -3, 0],
  },
  hint: {
    duration: 1600,
    left: [0, 24, 18, 0],
    right: [0, 8, 0],
    head: [0, 3, 3, 0],
    brows: [0, -2, 0],
  },
  encourage: {
    duration: 1500,
    left: [0, 16, 0],
    right: [0, -18, -18, 0],
    head: [0, -2, 0],
    brows: [0, -4, 0],
  },
};

export function mountMascot(
  host,
  { reducedMotion = false, onStatus = () => {} } = {},
) {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  const media = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  let localReduced = Boolean(reducedMotion),
    systemReduced = Boolean(media?.matches);
  let mode = 'teaching',
    dead = false,
    svg = null,
    loaded = false,
    failed = false;
  let generation = 0,
    timer = null,
    active = [];
  const panel = doc.createElement('div');
  panel.className = 'mascot-art';
  panel.style.width = '100%';
  const image = doc.createElement('img');
  image.src = fallback.href;
  image.alt = 'Friendly school capybara — accepted static v6 reference';
  image.style.width = '100%';
  image.style.height = 'auto';
  image.style.maxHeight = '360px';
  image.style.objectFit = 'contain';
  const text = doc.createElement('p');
  text.textContent = 'Your guide is here. Follow the activity instructions.';
  text.hidden = true;
  image.addEventListener('error', () => {
    if (dead) return;
    image.hidden = true;
    text.hidden = false;
  });
  panel.append(image, text);
  host.replaceChildren(panel);
  host.dataset.performance = 'rest';

  function status(value) {
    if (dead && value !== 'destroyed') return;
    host.dataset.motion = value;
    onStatus(value);
  }
  function layer(name) {
    return svg?.querySelector(`[data-layer="${name}"]`);
  }
  function face(name = 'rest') {
    if (!svg) return;
    for (const state of [
      'rest',
      'welcome',
      'hint',
      'encourage',
      'focused',
      'aha',
      'delighted',
    ]) {
      const mouth = layer(`mouth-${state}`);
      if (mouth) mouth.style.display = state === name ? '' : 'none';
    }
    for (const state of ['rest', 'hint', 'encourage', 'focused', 'delighted']) {
      const eyes = layer(`eyes-${state}`);
      if (eyes)
        eyes.style.display =
          state === (name === 'welcome' || name === 'aha' ? 'rest' : name)
            ? ''
            : 'none';
    }
  }
  function cancel() {
    generation++;
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
    active.forEach((animation) => animation.cancel());
    active = [];
    face();
    host.dataset.performance = 'rest';
  }
  function restingStatus() {
    return mode === 'quiet'
      ? 'quiet'
      : failed
        ? 'fallback'
        : loaded
          ? 'rest'
          : 'loading';
  }
  function settle() {
    panel.hidden = mode === 'quiet';
    status(restingStatus());
  }
  function animate(name, values, duration, translate = false) {
    const node = layer(name);
    if (!node?.animate) throw new Error('Layer animation unavailable');
    const animation = node.animate(
      values.map((value) => ({
        transform: translate ? `translateY(${value}px)` : `rotate(${value}deg)`,
      })),
      { duration, iterations: 1, easing: 'ease-in-out', fill: 'none' },
    );
    // Cancellation rejects WAAPI finished; completion is governed by the bounded timer.
    animation.finished?.catch?.(() => {});
    active.push(animation);
  }
  const controller = {
    perform(name) {
      if (dead || !performances[name]) return;
      cancel();
      if (
        mode === 'quiet' ||
        !loaded ||
        failed ||
        localReduced ||
        systemReduced ||
        media?.matches
      ) {
        settle();
        return;
      }
      const performance = performances[name],
        token = generation;
      face(name);
      host.dataset.performance = name;
      status('playing');
      try {
        animate('arm-left', performance.left, performance.duration);
        animate('arm-right', performance.right, performance.duration);
        animate('head', performance.head, performance.duration);
        animate('brows', performance.brows, performance.duration, true);
        animate(
          'eyes',
          [0, name === 'hint' ? 2 : -1, 0],
          performance.duration,
          true,
        );
        timer = win.setTimeout(() => {
          if (dead || token !== generation) return;
          cancel();
          settle();
        }, performance.duration);
      } catch {
        cancel();
        failed = true;
        panel.replaceChildren(image, text);
        settle();
      }
    },
    setMode(value) {
      if (dead || !['teaching', 'quiet'].includes(value)) return;
      cancel();
      mode = value;
      settle();
    },
    setReducedMotion(value) {
      if (dead) return;
      localReduced = Boolean(value);
      cancel();
      settle();
    },
    destroy() {
      if (dead) return;
      cancel();
      dead = true;
      media?.removeEventListener?.('change', preferenceChanged);
      media?.removeListener?.(preferenceChanged);
      host.replaceChildren();
      status('destroyed');
    },
  };
  function preferenceChanged(event) {
    if (dead) return;
    systemReduced = Boolean(event.matches);
    cancel();
    settle();
  }
  if (media?.addEventListener)
    media.addEventListener('change', preferenceChanged);
  else media?.addListener?.(preferenceChanged);
  status('loading');
  // Never queue a performance during loading. Importing respects current mode/preferences.
  win
    .fetch(asset.href)
    .then((response) => {
      if (!response.ok) throw new Error('Layered companion unavailable');
      return response.text();
    })
    .then((source) => {
      if (dead) return;
      const parsed = new win.DOMParser().parseFromString(
        source,
        'image/svg+xml',
      );
      if (
        parsed.querySelector('parsererror') ||
        (parsed.documentElement.localName &&
          parsed.documentElement.localName !== 'svg')
      )
        throw new Error('Invalid companion SVG');
      svg = doc.importNode(parsed.documentElement, true);
      svg.style.width = '100%';
      svg.style.height = 'auto';
      svg.style.maxHeight = '360px';
      for (const name of [
        'head',
        'arm-left',
        'arm-right',
        'brows',
        'eyes',
        'mouth-rest',
        'mouth-welcome',
        'mouth-hint',
        'mouth-encourage',
      ]) {
        if (!layer(name)) throw new Error('Missing companion layer');
      }
      loaded = true;
      face();
      panel.replaceChildren(svg);
      settle();
    })
    .catch(() => {
      if (dead) return;
      failed = true;
      svg = null;
      panel.replaceChildren(image, text);
      settle();
    });
  return controller;
}
