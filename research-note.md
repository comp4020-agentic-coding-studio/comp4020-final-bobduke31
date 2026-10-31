# Capability raises the ceiling; verification decides what you keep

Much writing on agentic coding says the harness (tools, instructions,
workflow) matters more than the model. A position paper argues, from
published results and one small experiment, that "harness-induced variance
can substantially exceed model-induced variance" (Zhang et al., 2026). My
project complicates this: for two weeks a Sonnet-class model failed to
produce acceptable terrain; after I switched to Opus, one session fixed the
worst problems. I argue that model capability is a first-order factor,
and that a sound workflow and reliable verification are equally essential:
capability changes what verification delivers, not whether it is needed.

## The case for capability

Hold the scaffold fixed and model gains are large: Anthropic's minimal
scaffold scored 22% with Claude 3 Opus, 33% with Claude 3.5 Sonnet and 49%
with its upgraded version on SWE-bench Verified (Schluntz, 2025).
Terminal-Bench's authors, comparing one model swap with one scaffold swap,
infer that "model selection is usually more important than agent scaffold"
(Merrill et al., 2026). A controlled study of two
models and three harnesses found that harness choice changed tokens per
solved task up to 40-fold, while pass rates within each model moved 0-8
points (Vats & Golev, 2026). Each source has interests, but together they
suggest that on these benchmarks the model sets much of what gets solved,
the harness much of the cost.

My records fit this. Sonnet 5 did all the work from 4 to 20 October, through
over half a dozen rejected visual approaches. It diagnosed the causes of the worst
artefacts, circular mountains and rectangular forests, but deferred fixing
them. Changing prompts, `CLAUDE.md` and workflow brought little
improvement, so I changed the model. On 20 October Opus 5.5 fixed both at
their source, the brush and the seed data, in one session; I judged the
result "much better than before".

## What capability did not fix

The switch was confounded: my prompt to Opus prescribed the diagnosis, and
Opus inherited Sonnet's analysis and a matured `CLAUDE.md`. Sonnet, back for
one evening, fixed an iPhone rendering bug both models had a hand in.
And Opus produced the project's worst integrity failure, reporting a backup
snapshot that did not exist and deploying on that basis.
A stronger model is not a more honest one: METR believes "this kind of
reward hacking is a general phenomenon, not isolated to any one model or
developer" (Von Arx et al., 2025).

Under both models, my records list eight cases where automated checks were
green but the result was visibly wrong, caught by using the app: drawing
tools that never appeared, two views disagreeing about where the sea was, a
phone showing a flat plane. Benchmarks show the
same gap: generated tests found that 29.6% of test-passing patches from
three agents on SWE-bench Verified behave differently from the developers'
fix (Wang et al., 2025), and in a study of agents building apps from
designs, 44.5% of audited runs never opened the design screenshots and 8.3%
claimed success after a failed check (Guo et al., 2026).

Written instructions were a weaker lever than I expected. A `CLAUDE.md` rule
to check the rendered result, in place from 11 October, did not stop two
rendering faults reaching me, nor the fabricated backup. This fits evidence
that providing context files "does not generally improve task success
rates", with developer-written files helping only slightly (Gloaguen et
al., 2026). What helped was a
runnable check: a measured gap between building and ground, a
screenshot-parity gate.

## Reconciling the two

The self-repair literature suggests why both matter. On reasoning tasks,
models "struggle to self-correct their responses without external feedback"
(Huang et al., 2024), and in code, self-repair is "bottlenecked by the
model's ability to provide feedback on its own code"; gains grew
substantially when a stronger model wrote the feedback (Olausson et al.,
2024). Capability and verification are complements: a weaker model with
the right diagnosis can still stall, as Sonnet did; a stronger one without
an external check can report unverified work, as Opus did.

The counter-case: research distrusts impressions like mine.
Sixteen experienced open-source developers estimated afterwards that AI had
cut their completion time by 20%, when it had increased it by 19% (Becker
et al., 2025). But that trial used early-2025 models, and METR now calls its
follow-up data "an unreliable signal", while believing developers are
likely more sped up in early 2026 (Becker et al., 2026). My claim rests on
records, not felt speed, but it is one uncontrolled project.

The defensible conclusion is narrower than either camp's: choose the model
for the hardest part of a task, since a better harness may not make up
for a weaker one, and build the workflow and checks as carefully, judging
any model's work by a check it does not control.

## References

- Becker, J., Rush, N., Barnes, E., & Rein, D. (2025). *Measuring the impact of early-2025 AI on experienced open-source developer productivity.* arXiv:2507.09089.
- Becker, J., Rush, N., Cunningham, T., Rein, D., & Mahamud, K. (2026, February 24). *We are changing our developer productivity experiment design.* METR. https://metr.org/blog/2026-02-24-uplift-update/
- Gloaguen, T., Mündler-Sasahara, N., Müller, M. N., Raychev, V., & Vechev, M. (2026). *Evaluating AGENTS.md: Are repository-level context files helpful for coding agents?* arXiv:2602.11988.
- Guo, J., Yao, Y., Li, C., Pan, Z., et al. (2026). *VISTA: An end-to-end benchmark for visual spec-to-web-app coding agents.* arXiv:2605.26144.
- Huang, J., Chen, X., Mishra, S., Zheng, H. S., et al. (2024). Large language models cannot self-correct reasoning yet. *ICLR 2024.* arXiv:2310.01798.
- Merrill, M. A., Shaw, A. G., Carlini, N., Li, B., et al. (2026). Terminal-Bench: Benchmarking agents on hard, realistic tasks in command line interfaces. *ICLR 2026.* arXiv:2601.11868.
- Olausson, T. X., Inala, J. P., Wang, C., Gao, J., & Solar-Lezama, A. (2024). Is self-repair a silver bullet for code generation? *ICLR 2024.* arXiv:2306.09896.
- Schluntz, E. (2025, January 6). *Raising the bar on SWE-bench Verified with Claude 3.5 Sonnet.* Anthropic. https://www.anthropic.com/research/swe-bench-sonnet
- Vats, N., & Golev, O. (2026). *The scaffold effect in coding agents: Harness choice as a hidden variable in coding-agent evaluation.* arXiv:2607.22585.
- Von Arx, S., Chan, L., & Barnes, B. (2025, June 5). *Recent frontier models are reward hacking.* METR. https://metr.org/blog/2025-06-05-recent-reward-hacking/
- Wang, Y., Pradel, M., & Liu, Z. (2025). *Are "solved issues" in SWE-bench really solved correctly? An empirical study.* arXiv:2503.15223.
- Zhang, Y., Wang, J., Ge, Y., Xu, W., Hamm, J., & Reddy, C. K. (2026). *Stop comparing LLM agents without disclosing the harness* (position paper). arXiv:2605.23950.
