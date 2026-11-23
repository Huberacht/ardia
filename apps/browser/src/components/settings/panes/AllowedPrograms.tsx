import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { approvalLine, refreshControlApprovals, revokeApproval, useControlApprovals } from "../../../state/automation/controlApprovals";
import { Button } from "../../ui";
import { Row } from "../Form";
import { setting } from "../settingsIndex";

export function AllowedProgramsRows() {
  const { approvals, problem, doorbell } = useControlApprovals(useShallow((s) => ({ approvals: s.approvals, problem: s.problem, doorbell: s.doorbell })));
  useEffect(() => void refreshControlApprovals(), []);
  const now = Date.now();
  const base = setting("advanced.allowedPrograms").description;
  const note = problem ?? (!doorbell ? `${base} This test instance lets every program of yours in without asking.` : approvals.length ? undefined : `${base} You haven't allowed any.`);
  return (
    <>
      <Row anchor="advanced.allowedPrograms" description={note} />
      {approvals.map((approval) => (
        <Row key={approval.key} title={approval.name} description={approvalLine(approval, now)}>
          <Button variant="icon" icon="trash" size="m" onPress={() => void revokeApproval(approval.key)} tooltip="Remove" />
        </Row>
      ))}
    </>
  );
}
