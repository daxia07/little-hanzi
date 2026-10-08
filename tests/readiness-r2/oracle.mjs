// Independently transcribed S1/R2 oracle. Never import product grading/content.
export const VERSION = 'forest-01-v3';
export const LESSON = 'forest-01';
export const SEED = 17;
export const INITIAL_TIME = '2026-09-25T00:00:00.000Z';
export const CORRECT = Object.freeze({
 'fam-mu':'mu','fam-lin':'lin','find-mu':'mu','find-lin':'lin',
 'check-mu-sound':'mu','check-lin-sound':'lin','check-mu-reading':'audio-mu','check-lin-reading':'audio-lin',
 'review-mu-sound':'mu','review-lin-sound':'lin',
});
export const ROUTES = Object.freeze({
 new:{familiarity:[['fam-mu','lin'],['fam-mu','mu'],['fam-lin','mu'],['fam-lin','lin']],modes:{mu:'introduction',lin:'introduction'},firstLook:{independentCorrect:0,supported:2,unavailable:0}},
 'mixed-mu':{familiarity:[['fam-mu','mu'],['fam-lin','mu'],['fam-lin','lin']],modes:{mu:'reminder',lin:'introduction'},firstLook:{independentCorrect:1,supported:1,unavailable:0}},
 'mixed-lin':{familiarity:[['fam-mu','lin'],['fam-mu','mu'],['fam-lin','lin']],modes:{mu:'introduction',lin:'reminder'},firstLook:{independentCorrect:1,supported:1,unavailable:0}},
 familiar:{familiarity:[['fam-mu','mu'],['fam-lin','lin']],modes:{mu:'reminder',lin:'reminder'},firstLook:{independentCorrect:2,supported:0,unavailable:0}},
});
export const FINAL_CLEAN = Object.freeze({total:4,independentCorrect:4,supported:0,unavailable:0,pending:0});
export const FINAL_HELPED = Object.freeze({total:4,independentCorrect:1,supported:2,unavailable:1,pending:0});
export const FINAL_HELP_SCRIPT = Object.freeze([
 ['answer','check-mu-sound','lin'],['answer','check-mu-sound','ren'],
 ['answer','check-lin-sound','lin'],['hint','check-mu-reading'],
 ['answer','check-mu-reading','audio-mu'],['audio-unavailable','check-lin-reading'],
]);
export const EXPECTED_SEED17 = Object.freeze({
 'fam-mu':['ren','mu','lin'],'fam-lin':['lin','mu','da'],
 'check-mu-sound':['mu','lin','ren'],'check-lin-sound':['mu','da','lin'],
 'check-mu-reading':['audio-ren','audio-mu','audio-lin'],'check-lin-reading':['audio-lin','audio-mu','audio-da'],
 'review-mu-sound':['lin','ren','mu'],'review-lin-sound':['da','lin','mu'],
});
