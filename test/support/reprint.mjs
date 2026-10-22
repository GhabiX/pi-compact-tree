// Rows already in scrollback change only through a cleared full redraw. Ctrl+O is the one
// ordinary change that may need one: while the blocks the toggle set moving
// have not all reached their target, a deferred target makes the plugin request a single
// cleared redraw, which starts a new frozen prefix. The returned function takes each checked
// frame and says whether it is that permitted reprint.
const moving = coordinator => coordinator.readBlocks().filter(block => block.phase === 'pending' || block.phase === 'transition').map(block => block.id);
export function ctrlOReprint() {
  let expanded, toggled = [], requested = false;
  return ({ toolsExpanded, redraws, coordinator }) => {
    const toggle = expanded !== undefined && toolsExpanded !== expanded;
    expanded = toolsExpanded;
    const open = toggle || toggled.length > 0;
    const permitted = (open || requested) && redraws === 1;
    // Without the plugin's frame there is nothing it could reprint.
    const settled = redraws > 0 || !coordinator;
    requested = !settled && open && coordinator.hasDeferred;
    toggled = settled || requested ? [] : moving(coordinator).filter(id => toggle || toggled.includes(id));
    return permitted;
  };
}
