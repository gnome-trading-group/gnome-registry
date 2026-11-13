-- The gnome-strategies commit a java session runs, as research_commit is the gnomepy-research one a python session
-- runs. Either pins the orchestrator and gnomepy releases recorded beside it.
ALTER TABLE strategy.session ADD COLUMN strategy_commit VARCHAR(40);
