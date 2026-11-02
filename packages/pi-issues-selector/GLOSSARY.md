# Pi Issues Selector

Pi Issues Selector lets users reference GitHub issues and pull requests within a user message.

## Language

**Issue Reference**:
An explicit mention of a GitHub issue or pull request in a user message, written `#123`, `owner/repo#123`, or as a Markdown link to its web page. One term covers both, because a repository numbers its issues and pull requests in one sequence.
_Avoid_: PR reference, ticket mention, issue link

**Issue Host**:
The hosting service (GitHub today) serving a remote's host name, recognised built in or from a host the service's CLI is signed in to.
_Avoid_: forge, provider, platform

**Issue Repository**:
The hosted repository a bare `#123` resolves against, chosen from the working directory's git remotes on an Issue Host the way `gh` chooses its base repository.
_Avoid_: Upstream repository, base repo, origin, reference repository
