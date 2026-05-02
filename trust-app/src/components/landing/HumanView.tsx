import { BuiltFor } from "./BuiltFor";
import { Compare } from "./Compare";
import { FAQ } from "./FAQ";
import { Features } from "./Features";
import { Footer } from "./Footer";
import { Hero } from "./Hero";
import { LandingHeader } from "./LandingHeader";
import { Pricing } from "./Pricing";
import { QuickStart } from "./QuickStart";
import { TrustBar } from "./TrustBar";

export function HumanView() {
  return (
    <div className="landing">
      <LandingHeader />
      <main>
        <Hero />
        <TrustBar />
        <Features />
        <QuickStart />
        <Compare />
        <BuiltFor />
        <Pricing />
        <FAQ />
      </main>
      <Footer />
    </div>
  );
}
