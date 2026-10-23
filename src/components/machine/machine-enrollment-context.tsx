import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import type { MachineEnrollment } from "../../contracts/machine";

const EnrollmentContext = createContext<{
  enrollment: MachineEnrollment | null;
  setEnrollment: (value: MachineEnrollment | null) => void;
}>({ enrollment: null, setEnrollment: () => {} });

export function useMachineEnrollment() {
  return useContext(EnrollmentContext);
}

export function MachineEnrollmentProvider({ children }: { children: ReactNode }) {
  const [enrollment, setEnrollment] = useState<MachineEnrollment | null>(null);
  return (
    <EnrollmentContext.Provider value={{ enrollment, setEnrollment }}>
      {children}
    </EnrollmentContext.Provider>
  );
}
