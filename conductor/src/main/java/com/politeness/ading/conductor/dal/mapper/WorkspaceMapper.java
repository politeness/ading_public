package com.politeness.ading.conductor.dal.mapper;

import com.politeness.ading.conductor.dal.entity.WorkspaceEntity;
import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface WorkspaceMapper {

    @Insert("""
            INSERT INTO workspaces (workspace_id, owner, terminal_id, name, path, kind)
            VALUES (#{workspaceId}, #{owner}, #{terminalId}, #{name}, #{path}, #{kind})
            """)
    int insert(WorkspaceEntity workspace);

    @Select("SELECT * FROM workspaces WHERE workspace_id = #{workspaceId}")
    WorkspaceEntity findByWorkspaceId(@Param("workspaceId") String workspaceId);

    @Select("SELECT * FROM workspaces WHERE owner = #{owner} AND kind = 'INBOX' ORDER BY id LIMIT 1")
    WorkspaceEntity findInbox(@Param("owner") String owner);

    /** "No workspace" goes last, the rest by most recently modified — same order as the standalone list */
    @Select("""
            SELECT * FROM workspaces
             WHERE owner = #{owner}
             ORDER BY kind = 'INBOX', gmt_modified DESC, id DESC
            """)
    List<WorkspaceEntity> listByOwner(@Param("owner") String owner);

    @Update("""
            UPDATE workspaces
               SET name = COALESCE(#{name}, name),
                   path = COALESCE(#{path}, path)
             WHERE workspace_id = #{workspaceId}
            """)
    int update(@Param("workspaceId") String workspaceId,
               @Param("name") String name,
               @Param("path") String path);

    @Delete("DELETE FROM workspaces WHERE workspace_id = #{workspaceId}")
    int delete(@Param("workspaceId") String workspaceId);
}
