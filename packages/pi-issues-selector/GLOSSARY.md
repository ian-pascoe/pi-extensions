# Pi Issues Selector

Pi Issues Selector lets users reference GitHub issues and pull requests, and GitLab issues and merge requests, within a user message.

## Language

**Issue Reference**:
An explicit mention of a GitHub issue or pull request, or a GitLab issue or merge request, in a user message, written `#123`, `owner/repo#123`, GitLab's `!123` for a merge request, or as a Markdown link to its web page. One term covers all of them. GitHub numbers a repository's issues and pull requests in one sequence, so `#` names either; GitLab numbers a project's merge requests separately from its issues, so `#` names an issue and `!` a merge request.
_Avoid_: PR reference, MR reference, merge request reference, ticket mention, issue link

**Issue Host**:
The hosting service (GitHub or GitLab) serving a remote's host name, recognised built in (`github.com`, `gitlab.com`) or from a host the service's CLI is signed in to or told to use (`gh`'s `hosts.yml` and `GH_HOST`; `glab`'s `config.yml`).
_Avoid_: forge, provider, platform

**Issue Repository**:
The hosted repository (a GitHub `owner/repo`, or a GitLab project at any group depth) a bare `#123` or `!123` resolves against, chosen from the working directory's git remotes, on a host name an Issue Host serves, the way `gh` and `glab` choose their base repository.
_Avoid_: Upstream repository, base repo, origin, reference repository
