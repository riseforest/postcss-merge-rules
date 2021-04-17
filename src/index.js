/* eslint-disable*/
import browserslist, { cache } from 'browserslist';
import postcss from 'postcss';
import vendors from 'vendors';
import clone from './lib/clone';
import ensureCompatibility from './lib/ensureCompatibility';

const prefixes = vendors.map(v => `-${v}-`);

function intersect(a, b, not) {
    return a.filter(c => {
        const index = ~b.indexOf(c);
        return not ? !index : index;
    });
}

const different = (a, b) => intersect(a, b, true).concat(intersect(b, a, true));
const filterPrefixes = selector => intersect(prefixes, selector);

function sameVendor(selectorsA, selectorsB) {
    let same = selectors => selectors.map(filterPrefixes).join();
    return same(selectorsA) === same(selectorsB);
}

const noVendor = selector => !filterPrefixes(selector).length;

function sameParent(ruleA, ruleB) {
    const hasParent = ruleA.parent && ruleB.parent;
    let sameType = hasParent && ruleA.parent.type === ruleB.parent.type;
    // If an at rule, ensure that the parameters are the same
    if (hasParent && ruleA.parent.type !== 'root' && ruleB.parent.type !== 'root') {
        sameType = sameType &&
            ruleA.parent.params === ruleB.parent.params &&
            ruleA.parent.name === ruleB.parent.name;
    }
    return hasParent ? sameType : true;
}

function canMerge(ruleA, ruleB, browsers, compatibilityCache) {
    const a = ruleA.selectors;
    const b = ruleB.selectors;

    const selectors = a.concat(b);

    if (!ensureCompatibility(selectors, browsers, compatibilityCache)) {
        return false;
    }

    const parent = sameParent(ruleA, ruleB);
    if (!ruleA.parent) return false;
    const { name } = ruleA.parent;
    if (parent && name && ~name.indexOf('keyframes')) {
        return false;
    }
    return parent && (selectors.every(noVendor) || sameVendor(a, b));
}

const getDecls = rule => rule.nodes ? rule.nodes.map(String) : [];
const joinSelectors = (...rules) => rules.map(s => s.selector).join();

function ruleLength(...rules) {
    return rules.map(r => r.nodes.length ? String(r) : '').join('').length;
}

function splitProp(prop) {
    const parts = prop.split('-');
    let base, rest;
    // Treat vendor prefixed properties as if they were unprefixed;
    // moving them when combined with non-prefixed properties can
    // cause issues. e.g. moving -webkit-background-clip when there
    // is a background shorthand definition.
    if (prop[0] === '-') {
        base = parts[2];
        rest = parts.slice(3);
    } else {
        base = parts[0];
        rest = parts.slice(1);
    }
    return [base, rest];
}

function isConflictingProp(propA, propB) {
    if (propA === propB) {
        return true;
    }
    const a = splitProp(propA);
    const b = splitProp(propB);
    return a[0] === b[0] && a[1].length !== b[1].length;
}

function hasConflicts(declProp, notMoved) {
    return notMoved.some(prop => isConflictingProp(prop, declProp));
}

function partialMerge(first, second, cacheList) {
    let intersection = intersect(getDecls(first), getDecls(second));
    if (!intersection.length) {
        return second;
    }
    let nextRule = second.next();
    if (nextRule && nextRule.type === 'rule' && canMerge(second, nextRule)) {
        let nextIntersection = intersect(getDecls(second), getDecls(nextRule));
        if (nextIntersection.length > intersection.length) {
            first = second; second = nextRule; intersection = nextIntersection;
        }
    }
    const recievingBlock = clone(second);
    recievingBlock.selector = joinSelectors(first, second);
    recievingBlock.nodes = [];
    second.parent.insertBefore(second, recievingBlock);
    const difference = different(getDecls(first), getDecls(second));
    const filterConflicts = (decls, intersectn) => {
        let willNotMove = [];
        return decls.reduce((willMove, decl) => {
            let intersects = ~intersectn.indexOf(decl);
            let prop = decl.split(':')[0];
            let base = prop.split('-')[0];
            let canMove = difference.every(d => d.split(':')[0] !== base);
            if (intersects && canMove && !hasConflicts(prop, willNotMove)) {
                willMove.push(decl);
            } else {
                willNotMove.push(prop);
            }
            return willMove;
        }, []);
    };
    intersection = filterConflicts(getDecls(first).reverse(), intersection);
    intersection = filterConflicts((getDecls(second)), intersection);
    const firstClone = clone(first);
    const secondClone = clone(second);
    const moveDecl = callback => {
        return decl => {
            if (~intersection.indexOf(String(decl))) {
                callback.call(this, decl);
            }
        };
    };
    firstClone.walkDecls(moveDecl(decl => {
        decl.remove();
        recievingBlock.append(decl);
    }));
    secondClone.walkDecls(moveDecl(decl => decl.remove()));
    const merged = ruleLength(firstClone, recievingBlock, secondClone);
    const original = ruleLength(first, second);
    if (merged < original) {
        first.replaceWith(firstClone);
        second.replaceWith(secondClone);
        cacheList[firstClone.selector] = firstClone;
        cacheList[secondClone.selector] = secondClone;
        cacheList[recievingBlock.selector] = recievingBlock;
        [firstClone, recievingBlock, secondClone].forEach(r => {
            if (!r.nodes.length) {
                r.remove();
                delete cacheList[r.selector];
            }
        });
        if (!secondClone.parent) {
            return recievingBlock;
        }
        return secondClone;
    } else {
        recievingBlock.remove();
        return second;
    }
}

function selectorMerger(browsers, compatibilityCache) {
    let cacheList = {};
    return function (rule) {
        if (cacheList[rule.selector]) {
            if (cacheList[rule.selector] === rule) return;
            if (!canMerge(rule, cacheList[rule.selector], browsers, compatibilityCache)) {
                return;
            }
            // Merge when both selectors are exactly equal
            // e.g. a { color: blue } a { font-weight: bold }
            const cached = getDecls(cacheList[rule.selector]);
            rule.walk(decl => {
                if (~cached.indexOf(String(decl))) {
                    return decl.remove();
                }
                //decl.moveTo(cacheList[rule.selector]);
                cacheList[rule.selector].append(decl);
            });
            rule.remove();
            return;
        }
        cacheList[rule.selector] = rule;
        for (let name in cacheList) {
            let cache = cacheList[name];
            // console.log('cache', cache.selector)
            // Ensure that we don't deduplicate the same rule; this is sometimes
            // caused by a partial merge
            if (cache === rule) {
                continue;
            }
            // Prime the cache with the first rule, or alternately ensure that it is
            // safe to merge both declarations before continuing
            if (!canMerge(rule, cache, browsers, compatibilityCache)) {
                continue;
            }
            // Merge when declarations are exactly equal
            // e.g. h1 { color: red } h2 { color: red }
            if (getDecls(rule).join(';') === getDecls(cache).join(';')) {
                delete cacheList[cache.selector];
                delete cacheList[rule.selector];
                rule.selector = joinSelectors(cache, rule);
                cache.remove();
                cacheList[rule.selector] = rule;
                continue
            }
            // Partial merge: check if the rule contains a subset of the last; if
            // so create a joined selector with the subset, if smaller.
            partialMerge(cache, rule, cacheList);
        }
    };
}

module.exports = (opts = {}) => {
       //checkOpts(opts)
       return {
         postcssPlugin: 'postcss-merge-rules2',
         Once (css, result)  {
            const { opts } = result;
            const browsers = browserslist(null, {
                stats: opts && opts.stats,
                path: opts && opts.from,
                env: opts && opts.env,
            });
            const compatibilityCache = {};
            css.walkRules(selectorMerger(browsers, compatibilityCache));
        }
       }
}
module.exports.postcss = true