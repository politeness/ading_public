package com.politeness.ading.conductor.dal.mapper;

import com.politeness.ading.conductor.dal.entity.UserEntity;
import java.util.List;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface UserMapper {

    @Insert("""
            INSERT INTO users (user_id, username, display_name, is_agent, password, status,
                               agent_type, agent_version, permission_level, persona, owner,
                               terminal_id, local_uuid, readiness)
            VALUES (#{userId}, #{username}, #{displayName}, #{isAgent}, #{password}, #{status},
                    #{agentType}, #{agentVersion}, #{permissionLevel}, #{persona}, #{owner},
                    #{terminalId}, #{localUuid}, #{readiness})
            """)
    int insert(UserEntity user);

    @Select("SELECT * FROM users WHERE user_id = #{userId}")
    UserEntity findByUserId(@Param("userId") String userId);

    @Select("SELECT * FROM users WHERE username = #{username}")
    UserEntity findByUsername(@Param("username") String username);

    @Select("""
            <script>
            SELECT * FROM users WHERE user_id IN
            <foreach item='id' collection='userIds' open='(' separator=',' close=')'>#{id}</foreach>
            </script>
            """)
    List<UserEntity> findByUserIds(@Param("userIds") List<String> userIds);

    @Select("SELECT * FROM users WHERE owner = #{owner} AND is_agent = 1 ORDER BY id")
    List<UserEntity> findAgentsByOwner(@Param("owner") String owner);

    @Update("""
            UPDATE users
               SET display_name     = COALESCE(#{displayName}, display_name),
                   permission_level = COALESCE(#{permissionLevel}, permission_level),
                   persona          = COALESCE(#{persona}, persona),
                   agent_version    = COALESCE(#{agentVersion}, agent_version)
             WHERE user_id = #{userId}
            """)
    int updateAgentProfile(UserEntity user);

    /** A human's own profile. Overwrites these four fields wholesale: an empty avatar, phone or email means clear it */
    @Update("""
            UPDATE users
               SET display_name = #{displayName},
                   avatar_url   = #{avatarUrl},
                   phone        = #{phone},
                   email        = #{email}
             WHERE user_id = #{userId} AND is_agent = 0
            """)
    int updateProfile(UserEntity user);

    /**
     * Change password. Touches only the password and token generation, so it does not clobber concurrent profile edits.
     *
     * Incrementing the generation means "invalidate every token issued before": tokens are stateless JWTs and the server stores none,
     * so the only way to expire old ones is to compare the generation in the payload with this column (see auth/TokenService).
     * Incrementing in SQL rather than read-then-write ensures concurrent password changes cannot compute the same new generation.
     */
    @Update("""
            UPDATE users
               SET password = #{password},
                   token_epoch = token_epoch + 1
             WHERE user_id = #{userId} AND is_agent = 0
            """)
    int updatePassword(UserEntity user);

    /**
     * Finding people to add as friends: a match requires an **exact** username, email or phone number, humans only.
     * No fuzzy matching, so it cannot be used to page through all users.
     */
    @Select("""
            SELECT * FROM users
             WHERE is_agent = 0 AND status = 'ACTIVE'
               AND (username = #{query} OR email = #{query} OR phone = #{query})
             ORDER BY id LIMIT 5
            """)
    List<UserEntity> findHumansByExactKey(@Param("query") String query);

    /** Core query for idempotent Agent registration: the same local identifier on the same computer always maps to the same Agent */
    @Select("SELECT * FROM users WHERE terminal_id = #{terminalId} AND local_uuid = #{localUuid} AND is_agent = 1")
    UserEntity findAgentByTerminalAndLocalUuid(@Param("terminalId") String terminalId,
                                              @Param("localUuid") String localUuid);

    /** Current read after a competing registration commits; bypass the transaction's old snapshot. */
    @Select("SELECT * FROM users WHERE terminal_id = #{terminalId} AND local_uuid = #{localUuid} AND is_agent = 1 FOR UPDATE")
    UserEntity findRegisteredAgentForUpdate(@Param("terminalId") String terminalId,
                                           @Param("localUuid") String localUuid);

    /** All Agents on one computer */
    @Select("SELECT * FROM users WHERE terminal_id = #{terminalId} AND is_agent = 1 ORDER BY id")
    List<UserEntity> findAgentsByTerminal(@Param("terminalId") String terminalId);

    /** When the local identifier scheme changes, rename the identifier in place; the Agent stays the same (userId, contacts and history unchanged) */
    @Update("UPDATE users SET local_uuid = #{localUuid} WHERE user_id = #{userId} AND terminal_id = #{terminalId} AND is_agent = 1")
    int updateAgentLocalUuid(@Param("terminalId") String terminalId,
                             @Param("userId") String userId,
                             @Param("localUuid") String localUuid);

    /** The computer the Agent is on; empty for humans or when not found */
    @Select("SELECT terminal_id FROM users WHERE user_id = #{userId} AND is_agent = 1")
    String findTerminalIdOfAgent(@Param("userId") String userId);

    /**
     * Agent state published by this computer: readiness and version. A null version means unchanged.
     * Only the Agent's own computer can change it: the terminal_id condition is the permission boundary
     */
    @Update("""
            UPDATE users SET readiness = #{readiness},
                             agent_version = COALESCE(#{agentVersion}, agent_version),
                             model_state = COALESCE(#{modelState}, model_state)
             WHERE user_id = #{userId} AND terminal_id = #{terminalId} AND is_agent = 1
            """)
    int updateAgentState(@Param("terminalId") String terminalId,
                         @Param("userId") String userId,
                         @Param("readiness") String readiness,
                         @Param("agentVersion") String agentVersion,
                         @Param("modelState") String modelState);

    /** Token validation only needs this one number; no need to load the whole user row */
    @Select("SELECT token_epoch FROM users WHERE user_id = #{userId}")
    Integer findTokenEpoch(@Param("userId") String userId);

    /** Serializes, within a transaction, per-account data that must exist only once (e.g. "No workspace") */
    @Select("SELECT id FROM users WHERE user_id = #{userId} FOR UPDATE")
    Long lockByUserId(@Param("userId") String userId);

    @Select("SELECT COUNT(1) FROM users WHERE username = #{username}")
    int countByUsername(@Param("username") String username);
}
