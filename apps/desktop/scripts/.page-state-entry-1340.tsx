import "/Users/barreloflube/.t3/worktrees/ardia/t3-d9492397-0f3c404f29f39846/apps/browser/src/state/browser/store.ts";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import * as linux from "/Users/barreloflube/.t3/worktrees/ardia/t3-d9492397-0f3c404f29f39846/apps/desktop/src/SiteConnection.tsx";
import * as shared from "/Users/barreloflube/.t3/worktrees/ardia/t3-d9492397-0f3c404f29f39846/apps/browser/src/components/site/SiteConnection.tsx";
export {linux,shared};
export const render=(kind,security)=>renderToStaticMarkup(createElement(linux[kind],{security,open:false,onPress:()=>{}}));
